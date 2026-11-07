import {expect,it} from 'vitest';
import {isChatRequest} from '@/lib/demo-runtime';
import {MAX_COMPOSER_TEXT_CHARS} from '@/lib/chat-input-limits';
import {withOutreachPaneContext} from '@/ui/outreach-context';
const request=(text:string)=>({projectId:'11111111-1111-4111-8111-111111111111',threadId:'22222222-2222-4222-8222-222222222222',userMessageId:'33333333-3333-4333-8333-333333333333',assistantMessageId:'44444444-4444-4444-8444-444444444444',message:withOutreachPaneContext(text,{section:'overview'}),displayMessage:text,preferences:{tone:'balanced',language:'en',showActivity:true},options:{mode:'agent',experience:'smart',model:null,effort:null,webSearch:true,imageGeneration:false,skill:null,attachments:[]}});
it('accepts full composer text with hidden Outreach references beyond the old 500-character display bound',()=>{
 for(const length of [501,1000,MAX_COMPOSER_TEXT_CHARS]){const body=request('a'.repeat(length));expect(body.message.length).toBeGreaterThan(length);expect(isChatRequest(body)).toBe(true);}
});
it('retains an explicit visible-text boundary and rejects non-text display values',()=>{
 expect(isChatRequest(request('a'.repeat(MAX_COMPOSER_TEXT_CHARS+1)))).toBe(false);
 expect(isChatRequest({...request('Valid user text'),displayMessage:{approved:true}})).toBe(false);
});
