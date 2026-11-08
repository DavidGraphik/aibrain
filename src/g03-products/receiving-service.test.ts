import {afterEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const calls=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),capabilities:vi.fn(async()=>({providerWrites:false,productionWrites:false}))}));
vi.mock('@/connectors/g03-sage-service',()=>({g03SageReadForIdentity:calls.read,g03SageReceivingCapabilities:calls.capabilities,g03SageReceiptWriteForIdentity:calls.write}));
import {createReceivingProvider} from './receiving-service';
import type {ReceivingReceipt} from './receiving';
import type {ProductContext} from './access';
import type {InstallationConfig} from '@/config/installation-schema';
afterEach(()=>{vi.clearAllMocks();vi.useRealTimers();});
const valid=()=>({Price:12.5,VATIncluded:false,ProductDiscountRate:0,ProductDiscount2Rate:0,ProductDiscount3Rate:0});
function receipt(sourceLine:Record<string,unknown>):ReceivingReceipt{return {id:'11111111-1111-4111-8111-111111111111',key:'fixture',quantity:3,supplierDeliveryNote:'NOTE-QA',issueDate:'2026-10-27',actor:'employee',createdAt:'2026-10-27',state:'validated',validator:'validator',providerAttempts:0,binding:{id:'22222222-2222-4222-8222-222222222222',orderRow:2,workOrder:'OF-QA',orderReference:'PIECE',orderUnits:10,purchase:{period:'2026',serie:'P',number:'5',position:1},vendorId:'V',productId:'BAR',storeId:'A',receiptSerie:'R',unit:'barres',sageUnitCode:'BAR',materialRequired:10,piecesPerUnit:2,approvedBy:'validator',approvedAt:'2026-10-27',sourceOrder:{},sourceLine}};}
async function provider(){return createReceivingProvider({installationId:'g03-qa',actor:'validator'} as ProductContext,{installationId:'g03-qa',paths:{usersRoot:'/isolated/not-read'}} as InstallationConfig);}
it.each([false,0])('the real provider prepare accepts only explicit non-VAT metadata and preserves exact source price (%s)',async vat=>{
 const p=await provider();const prepared=p.prepare(receipt({...valid(),VATIncluded:vat}));
 expect(prepared).toMatchObject({tables:[{tableName:'TmpIME_CabeceraDocumento',values:{CodigoEmpresa:'1',CodigoDocumentoLc:'ALP'},lines:[{line:{Precio:'12.5',Unidades:'3',UnidadMedida1_:'BAR'}}]}]});expect(calls.read).not.toHaveBeenCalled();expect(calls.write).not.toHaveBeenCalled();
});
it('allows explicitly represented decimal-zero discount strings without coercing other values',async()=>{
 const p=await provider();expect(()=>p.prepare(receipt({...valid(),ProductDiscountRate:'0',ProductDiscount2Rate:'0.00',ProductDiscount3Rate:'0.0000'}))).not.toThrow();
});
it.each(['VATIncluded','ProductDiscountRate','ProductDiscount2Rate','ProductDiscount3Rate'])('the real provider prepare blocks missing %s instead of treating it as zero',async key=>{
 const source:Record<string,unknown>=valid();delete source[key];const p=await provider();expect(()=>p.prepare(receipt(source))).toThrowError(/verificar explícitament/);expect(calls.write).not.toHaveBeenCalled();
});
it.each([null,undefined,true,false,'',' ',NaN,{},'false','0e0',1,-1])('blocks absent, malformed and nonzero discount metadata (%s)',async value=>{
 const p=await provider();expect(()=>p.prepare(receipt({...valid(),ProductDiscount2Rate:value}))).toThrowError(/verificar explícitament/);expect(calls.write).not.toHaveBeenCalled();
});
it.each([null,undefined,true,'',' ',NaN,{},'false','0',1,-1])('blocks unsupported VATIncluded values without boolean coercion (%s)',async value=>{
 const p=await provider();expect(()=>p.prepare(receipt({...valid(),VATIncluded:value}))).toThrowError(/verificar explícitament/);expect(calls.write).not.toHaveBeenCalled();
});
it('preserves explicit empty units through the actual adapter and refuses an absent unit',async()=>{
 const p=await provider(),r=receipt(valid());r.binding.sageUnitCode='';expect(p.prepare(r)).toMatchObject({tables:[{lines:[{line:{UnidadMedida1_:''}}]}]});delete (r.binding as Partial<typeof r.binding>).sageUnitCode;expect(()=>p.prepare(r)).toThrow(/unitat SAGE explícita/);
});
const confirmed={companyCode:'1',period:2026,serie:'',number:42};
const stock=()=>({Id:'33333333-3333-4333-8333-333333333333',CompanyId:1,ProductId:'BAR',StoreId:'A',Note:'Albarán compra:2026//42',Quantity:3,Type:1,MeasureUnitId:'',DateAndTime:'2026-11-05T09:00:00'});
it('uses the reread ALP identity and complete pagination through a later posting date, with canonical actor permissions',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));const p=await provider(),r=receipt(valid());r.binding.sageUnitCode='';r.issueDate='2026-11-03';
 calls.read.mockResolvedValueOnce({items:[],nextOffset:50,complete:false}).mockResolvedValueOnce({items:[stock()],nextOffset:null,complete:true});
 expect(await p.stockProof(r,confirmed)).toBe(true);expect(calls.read.mock.calls).toEqual([
 ['g03-qa','validator','read',{query:'StockMovements',parameters:{FechaInicial:'2026-11-03',FechaFinal:'2026-11-05'},skip:0,take:50}],
 ['g03-qa','validator','read',{query:'StockMovements',parameters:{FechaInicial:'2026-11-03',FechaFinal:'2026-11-05'},skip:50,take:50}]]);expect(calls.write).not.toHaveBeenCalled();
});
it.each([{items:[stock()],nextOffset:null,complete:false},{items:[stock()],nextOffset:null,complete:true,limitReached:true},{items:[stock()],nextOffset:0,complete:false},{items:[stock()],nextOffset:5001,complete:false}])('does not confirm stock from partial or invalid coverage %j',async page=>{
 const p=await provider(),r=receipt(valid());r.binding.sageUnitCode='';calls.read.mockResolvedValueOnce(page);expect(await p.stockProof(r,confirmed)).toBe(false);expect(calls.read).toHaveBeenCalledTimes(1);
});
it('does not mistake the AI document marker for the provider causal stock note',async()=>{
 const p=await provider(),r=receipt(valid());r.binding.sageUnitCode='';calls.read.mockResolvedValueOnce({items:[{...stock(),Note:'AI:'+r.id}],nextOffset:null,complete:true});expect(await p.stockProof(r,confirmed)).toBe(false);
});
