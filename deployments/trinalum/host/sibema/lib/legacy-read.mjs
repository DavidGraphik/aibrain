import {readApi} from './api-request.mjs';
import {readOfferLineReferences,readProductCatalog} from './offer-reference-lines.mjs';

const allowedPath=/^\/(customers|providers|offers|orders|order-statuses|invoices\/(sale|purchase)|accounting\/(accounts|entries|third-parties))(?:[/?]|$)/;

/** Retain the legacy launcher's read contract while exposing exact native grades. */
export async function legacyRead(client,path){
 if(typeof path!=='string'||!path||path.includes('..')||path.includes('#'))throw Error('Unsupported read path');
 if(path==='/payment-methods'||/^\/orders\/[1-9]\d*\/conditions$/.test(path))return readApi(client,{path});
 if(/^\/customers\/[1-9]\d*\/tariffs$/.test(path))return readApi(client,{path});
 if(/^\/orders\/[1-9]\d*\/files(?:\/[1-9]\d*\/content)?$/.test(path))return readApi(client,{path});
 if(path==='/catalog')return legacyCatalog(client);
 if(!allowedPath.test(path))throw Error('Unsupported read path');
 const data=await client.get(path);
 const exactOffer=/^\/offers\/[1-9]\d*(?:\?[^#]*)?$/.test(path);
 return {source:'SIBEMA',path,data:exactOffer?await readOfferLineReferences(client,data):data,
  ...(exactOffer?{referenceInterpretation:{exactGradeField:'lines[].reference',productIdMeaning:'Native product family. Exact grade references are preserved separately in each line.',providerProductListMeaning:'A provider product list is a tariff relation, not the complete native catalogue. An empty list does not imply a missing product family.',catalogCommand:'trinalum-sibema-read catalog',writeReferenceField:'create_offer/update_offer request.lineReferences: one exact grade per body.lines entry'}}:{}),
  untrustedSourceContent:true};
}

export async function legacyCatalog(client,input={}){
 return {source:'SIBEMA',path:'/catalog',data:await readProductCatalog(client,input),
  referenceInterpretation:{productIdMeaning:'Native product family; resolve each grade using exact source and returned historical evidence. Keep ambiguous mappings explicit.',writeReferenceField:'create_offer/update_offer request.lineReferences: one exact grade per body.lines entry',providerProductListMeaning:'An empty provider tariff list does not imply an empty product catalogue.'},untrustedSourceContent:true};
}
