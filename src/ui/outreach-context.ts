export type OutreachPaneSection = 'overview' | 'campaigns' | 'replies' | 'tier1' | 'strategy';
export type OutreachPaneContext = {section: OutreachPaneSection; campaignId?: string};
const sections: readonly string[] = ['overview','campaigns','replies','tier1','strategy'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UI references help resolve "this campaign"; tools still authorize every read. */
export function withOutreachPaneContext(message: string, context: OutreachPaneContext): string {
  if (!sections.includes(context.section)) return message;
  const reference = {section:context.section, ...(context.campaignId && uuid.test(context.campaignId)
    ? {campaignId:context.campaignId} : {})};
  return `${message.trim()}\n\nSelected Outreach workspace references (not permission to act): ${JSON.stringify(reference)}`;
}
