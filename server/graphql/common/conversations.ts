import { pick } from 'lodash';
import { Unauthorized, FeatureNotSupportedForCollective, NotFound } from '../errors';
import models, { sequelize } from '../../models';
import hasFeature, { FEATURES } from '../../lib/allowed-features';

/** Params given to create a new conversation */
interface ICreateConversationParams {
  title: string;
  html: string;
  CollectiveId: number;
  tags?: String[] | null;
}

/**
 * Create a conversation started by the given `remoteUser`.
 *
 * @returns the conversation
 */
export const createConversation = async (remoteUser, params: ICreateConversationParams) => {
  // For now any authenticated user can create a conversation to any collective
  if (!remoteUser) {
    throw new Unauthorized();
  }

  // Collective must exist and be of type `COLLECTIVE`
  const collective = await models.Collective.findByPk(params.CollectiveId);
  if (!collective) {
    throw new Error("This Collective doesn't exist or has been deleted");
  } else if (!hasFeature(collective, FEATURES.CONVERSATIONS)) {
    throw new FeatureNotSupportedForCollective();
  }

  // Use a transaction to make sure conversation is not created if comment creation fails
  const conversation = await sequelize.transaction(async t => {
    // Create conversation
    const conversation = await models.Conversation.create(
      {
        CreatedByUserId: remoteUser.id,
        CollectiveId: collective.id,
        FromCollectiveId: remoteUser.CollectiveId,
        title: params.title,
        tags: params.tags,
        summary: params.html,
      },
      { transaction: t },
    );

    // Create comment
    const comment = await models.Comment.create(
      {
        CollectiveId: collective.id,
        ConversationId: conversation.id,
        CreatedByUserId: remoteUser.id,
        FromCollectiveId: remoteUser.CollectiveId,
        html: params.html,
      },
      { transaction: t },
    );

    return conversation.update({ RootCommentId: comment.id }, { transaction: t });
  });

  await models.ConversationFollower.follow(remoteUser.id, conversation.id);
  return conversation;
};

interface IEditConversationParams {
  id: number;
  title: string;
}

/**
 * Edit a conversation started by the given `remoteUser`.
 *
 * @returns the conversation
 */
export const editConversation = async (remoteUser, params: IEditConversationParams) => {
  if (!remoteUser) {
    throw new Unauthorized();
  }

  // Collective must exist and use be author or collective admin
  const conversation = await models.Conversation.findByPk(params.id);
  if (!conversation) {
    throw new NotFound();
  } else if (!remoteUser.isAdmin(conversation.FromCollectiveId) && !remoteUser.isAdmin(conversation.CollectiveId)) {
    throw new Unauthorized();
  }

  return conversation.update(pick(params, ['title']));
};
