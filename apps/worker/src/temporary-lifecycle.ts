import type { DomainRepository } from "@dg-chat/database";

export async function purgeTemporaryConversationBatch(
  repository: DomainRepository,
  limit: number,
  now?: string,
): Promise<{ conversationIds: string[]; hasMore: boolean }> {
  const result = await repository.purgeExpiredTemporaryConversations({ limit, now });
  return {
    conversationIds: result.conversationIds,
    hasMore: result.conversationIds.length === limit,
  };
}
