import { productRoute, boundedBody } from '@/g03-products/http';
import { getSession } from '@/auth/session';
import { requireProduct } from '@/g03-products/contracts';
import { createWelcomeChat } from '@/g03-products/welcome-chat';
import { welcomeProfile } from '@/g03-products/welcome-profile';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return productRoute(request,async ctx=>{
  const session=await getSession();requireProduct(session&&session.user.id===ctx.actor,'No autenticat.',401);
  const state=await ctx.store.read<{revision:number;seen:boolean}>(`welcome-${ctx.actor}`);
  return {...welcomeProfile(session.user.email,session.user.name),seen:state?.seen===true};
});}
export async function POST(request:Request){return productRoute(request,async ctx=>{
  const body=await boundedBody(request);
  requireProduct(body && Object.keys(body).length===1 && (body.seen===true || body.openChat===true),'Petició invàlida.');
  if (body.openChat===true) {
    const session=await getSession();requireProduct(session&&session.user.id===ctx.actor,'No autenticat.',401);
    const state=await ctx.store.read<{revision:number;seen:boolean;chatThreadId?:string}>(`welcome-${ctx.actor}`);
    if (state?.chatThreadId) return {threadId:state.chatThreadId,created:false};
    const thread=await createWelcomeChat(session);
    await ctx.store.mutate<{revision:number;seen:boolean;chatThreadId?:string},void>(`welcome-${ctx.actor}`,()=>({revision:0,seen:false}),v=>{v.chatThreadId=thread.id;v.seen=true;});
    return {threadId:thread.id,created:true};
  }
  return ctx.store.mutate(`welcome-${ctx.actor}`,()=>({revision:0,seen:false}),v=>{v.seen=true;return {seen:true};});
});}
