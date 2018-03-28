import { expect } from 'chai';
import { describe, it } from 'mocha';

import * as utils from './utils';
import models from '../server/models';
import roles from '../server/constants/roles';
import sinon from 'sinon';
import * as libcurrency from '../server/lib/currency';

let host, admin, user, collective, paypalPaymentMethod;

describe('graphql.paymentMethods.test.js', () => {

  beforeEach(() => utils.resetTestDB());

  beforeEach(() => models.User.createUserWithCollective({
    name: "Host Admin",
    email: "admin@email.com"
  }).tap(u => admin = u));

  beforeEach(() => models.User.createUserWithCollective({
    name: 'Xavier',
    currency: 'EUR',
    email: 'xxxx@email.com'
  }).tap(u => user = u));

  beforeEach(() => models.Collective.create({
    name: 'open source collective',
    type: "ORGANIZATION",
    currency: 'USD'
  }).tap(c => host = c).then(c => c.becomeHost()));

  beforeEach(() => models.ConnectedAccount.create({
    CollectiveId: host.id,
    service: 'stripe'
  }));

  beforeEach(() => models.Collective.create({
    name: "tipbox",
    type: "COLLECTIVE",
    isActive: true,
    currency: "EUR",
    hostFeePercent: 5,
    HostCollectiveId: host.id
  }).tap(c => collective = c));

  beforeEach(() => models.Member.create({
    CollectiveId: collective.id,
    MemberCollectiveId: host.id,
    role: roles.HOST,
    CreatedByUserId: admin.id
  }));

  beforeEach(() => host.addUserWithRole(admin, roles.ADMIN));
  beforeEach(() => collective.addUserWithRole(admin, roles.ADMIN));

  beforeEach('create a paypal paymentMethod', () => models.PaymentMethod.create({
    service: 'paypal',
    type: 'adaptive',
    name: 'host@paypal.com',
    data:  { redirect: "http://localhost:3000/brusselstogether/collectives/expenses" },
    token: 'PA-5GM04696CF662222W',
    CollectiveId: host.id
  }).then(pm => paypalPaymentMethod = pm));

  beforeEach('adding transaction from host (USD) to reimburse user\'s expense in a European chapter (EUR)', () => models.Transaction.createDoubleEntry({
    CreatedByUserId: admin.id,
    CollectiveId: host.id,
    HostCollectiveId: host.id,
    FromCollectiveId: user.CollectiveId,
    amount: -1000,
    currency: 'EUR',
    hostCurrency: 'USD',
    hostCurrencyFxRate: 1.15,
    amountInHostCurrency: -1150,
    paymentProcessorFeeInHostCurrency: 100,
    netAmountInCollectiveCurrency: -1250,
    PaymentMethodId: paypalPaymentMethod.id
  }));

  describe('oauth flow', () => {

  });

  describe('add funds', () => {
    let order, sandbox;
    const fxrate = 1.1654; // 1 EUR = 1.1654 USD

    beforeEach(() => {
      sandbox = sinon.sandbox.create();
      sandbox.stub(libcurrency, 'getFxRate', () => Promise.resolve(fxrate));
      return models.PaymentMethod.findOne({
        where: {
          service: 'opencollective',
          CollectiveId: host.id,
          type: 'collective'
        }
      }).then(pm => {
        order = {
          totalAmount: 1000, // €10
          collective: {
            id: collective.id
          },
          paymentMethod: {
            uuid: pm.uuid
          }
        }
      })
    })

    afterEach(() => {
      sandbox.restore();
    });

    const createOrderQuery = `
    mutation createOrder($order: OrderInputType!) {
      createOrder(order: $order) {
        id
        fromCollective {
          id
          slug
        }
        collective {
          id
          slug
        }
        totalAmount
        currency
        description
      }
    }
    `;

    it('fails to add funds if not logged in as an admin of the host', async () => {

      order.fromCollective = {
        id: host.id
      };
      const result = await utils.graphqlQuery(createOrderQuery, { order }, user);
      result.errors && console.error(result.errors[0]);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`You don't have sufficient permissions to create an order on behalf of the open source collective organization`);

      order.user = {
        email: 'admin@neworg.com',
        name: 'Paul Newman'
      };
      order.fromCollective = {
        name: "new org",
        website: "http://neworg.com"
      };
      const result2 = await utils.graphqlQuery(createOrderQuery, { order }, user);
      result2.errors && console.error(result2.errors[0]);
      expect(result2.errors).to.exist;
      expect(result2.errors[0].message).to.equal(`You don't have sufficient permissions to access this payment method`);
    });

    it('fails to change platformFeePercent if not root', async () => {
      order.fromCollective = {
        id: host.id
      };
      order.platformFeePercent = 5;
      const result = await utils.graphqlQuery(createOrderQuery, { order }, user);
      result.errors && console.error(result.errors[0]);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`Only a root can change the platformFeePercent`);
    });

    it('fails to add funds to a collective not hosted on the same host', async () => {

      const collective2 = await models.Collective.create({
        name: "wwcode austin",
        type: "COLLECTIVE",
        isActive: true,
        currency: "USD",
        hostFeePercent: 5,
        HostCollectiveId: user.CollectiveId
      });
      order.collective = { id: collective2.id };
      order.fromCollective = {
        id: host.id
      };

      const result = await utils.graphqlQuery(createOrderQuery, { order }, admin);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`You need to use the payment method of the host (${user.CollectiveId}) to add funds to this collective`);
    });

    it('adds funds from the host (USD) to the collective (EUR)', async () => {

      order.fromCollective = {
        id: host.id
      };
      const result = await utils.graphqlQuery(createOrderQuery, { order }, admin);
      result.errors && console.error(result.errors[0]);
      expect(result.errors).to.not.exist;
      const orderCreated = result.data.createOrder;
      const transaction = await models.Transaction.findOne({ where: { OrderId: orderCreated.id, type: 'CREDIT' }});
      expect(transaction.FromCollectiveId).to.equal(transaction.HostCollectiveId);
      expect(transaction.hostFeeInHostCurrency).to.equal(0);
      expect(transaction.platformFeeInHostCurrency).to.equal(0);
      expect(transaction.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(transaction.hostCurrency).to.equal(host.currency);
      expect(transaction.currency).to.equal(collective.currency);
      expect(transaction.amount).to.equal(order.totalAmount);
      expect(transaction.netAmountInCollectiveCurrency).to.equal(order.totalAmount);
      expect(transaction.amountInHostCurrency).to.equal(Math.round(order.totalAmount * fxrate));
      expect(transaction.hostCurrencyFxRate).to.equal(Number((1/fxrate).toFixed(15)));
      expect(transaction.amountInHostCurrency).to.equal(1165);
    });

    it('adds funds from the host (USD) to the collective (EUR) on behalf of a new organization', async () => {

      const hostFeePercent = 4;
      order.hostFeePercent = hostFeePercent;
      order.user = {
        email: 'admin@neworg.com',
        name: 'Paul Newman'
      };
      order.fromCollective = {
        name: "new org",
        website: "http://neworg.com"
      };
      const result = await utils.graphqlQuery(createOrderQuery, { order }, admin);
      result.errors && console.error(result.errors[0]);
      expect(result.errors).to.not.exist;
      const orderCreated = result.data.createOrder;
      const transaction = await models.Transaction.findOne({ where: { OrderId: orderCreated.id, type: 'CREDIT' }});
      const org = await models.Collective.findOne({ where: { slug: 'new-org' }});
      expect(transaction.CreatedByUserId).to.equal(admin.id);
      expect(org.CreatedByUserId).to.equal(admin.id);
      expect(transaction.FromCollectiveId).to.equal(org.id);
      expect(transaction.hostFeeInHostCurrency).to.equal(-Math.round(hostFeePercent/100*order.totalAmount*fxrate));
      expect(transaction.platformFeeInHostCurrency).to.equal(0);
      expect(transaction.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(transaction.hostCurrency).to.equal(host.currency);
      expect(transaction.currency).to.equal(collective.currency);
      expect(transaction.amount).to.equal(order.totalAmount);
      expect(transaction.netAmountInCollectiveCurrency).to.equal(order.totalAmount * (1-hostFeePercent/100));
      expect(transaction.amountInHostCurrency).to.equal(Math.round(order.totalAmount * fxrate));
      expect(transaction.hostCurrencyFxRate).to.equal(Number((1/fxrate).toFixed(15)));
      expect(transaction.amountInHostCurrency).to.equal(1165);
    });
  });

  describe('get the balance', () => {

    it("returns the balance", async () => {

      const query = `
      query Collective($slug: String!) {
        Collective(slug: $slug) {
          id,
          paymentMethods {
            id
            service
            type
            balance
            currency
          }
        }
      }
      `;
      const result = await utils.graphqlQuery(query, { slug: host.slug }, admin);
      result.errors && console.error(result.errors[0]);
      expect(result.errors).to.not.exist;
      const paymentMethod = result.data.Collective.paymentMethods.find(pm => pm.service === 'paypal');
      expect(paymentMethod.balance).to.equal(198750); // $2000 - $12.50
    });

  })

});