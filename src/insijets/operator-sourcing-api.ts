import type { AuthSession } from "../auth/types";
import {canAccessInsiJetsCMS} from "./cms-access";
import {OperatorSourcingStore} from "./operator-sourcing-store";
import {shortlistAircraft,prepareAvailabilityDrafts} from "./availability-planner.mjs";
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
export async function operatorSourcingResponse(request:Request,configuration:{installationId:string;origin:string;dataRoot:string;enabled:boolean},session:AuthSession|null){
 const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
 if(!session)return json({error:"AUTH_REQUIRED"},401);
 if(!canAccessInsiJetsCMS(session,configuration.installationId))return json({error:"ACCESS_DENIED"},403);
 if(!configuration.enabled)return json({error:"MULTISOURCE_NOT_CONFIGURED"},503);
 if(request.headers.get("sec-fetch-site")==="cross-site"||(request.method!=="GET"&&request.headers.get("origin")!==configuration.origin))return json({error:"ORIGIN_DENIED"},403);
 if(!["GET","POST"].includes(request.method))return json({error:"METHOD_DENIED"},405);
 let store:OperatorSourcingStore|undefined;
 try{
   let body:Record<string,unknown>|null=null;
   if(request.method==="POST"){
     if(!request.headers.get("content-type")?.startsWith("application/json"))return json({error:"JSON_REQUIRED"},415);
     const reader=request.body?.getReader();if(!reader)return json({error:"BODY_REQUIRED"},400);
     const chunks:Uint8Array[]=[];let length=0;
     while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>8192){await reader.cancel();return json({error:"REQUEST_TOO_LARGE"},413);}chunks.push(part.value);}
     body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
     if(!body||Array.isArray(body)||Object.keys(body).some(k=>!["originAirport","destinationAirport","originCity","passengers","repositionCountries","reference","departureISO","timeZone","sender","flightType","limit"].includes(k)))throw Error("Invalid request fields");
   }
   store=new OperatorSourcingStore(configuration.dataRoot);
   if(request.method==="GET"){
     const p=new URL(request.url).searchParams;
     if([...p.keys()].some(k=>!["view","query","airport","country","minSeats","limit","page"].includes(k)))throw Error("Unknown filter");
     if(p.has('view')&&!['operators','aircraft'].includes(p.get('view')!))throw Error('Invalid view');
     if(p.get('view')==='operators')return json({summary:store.summary(),result:store.browseOperators(p.get('query')||'',Number(p.get('limit')||30),Number(p.get('page')||1))});
     return json({summary:store.summary(),result:store.browse({query:p.get("query")||undefined,airport:p.get("airport")||undefined,country:p.get("country")||undefined,minSeats:p.has("minSeats")?Number(p.get("minSeats")):undefined,limit:p.has("limit")?Number(p.get("limit")):undefined,page:p.has("page")?Number(p.get("page")):undefined})});
   }
   const {limit,...trip}=body!;const shortlist=shortlistAircraft(store.planningDataset(),trip,{limit:limit??30});
   return json({summary:store.summary(),shortlist,preparation:prepareAvailabilityDrafts(shortlist,trip),notice:"Published inventory only. No confirmed availability, quotes or sends."});
 }catch(error){return json({error:error instanceof Error?error.message:"INVALID_REQUEST"},400);}finally{store?.close();}
}
