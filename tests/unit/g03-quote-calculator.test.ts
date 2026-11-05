import { expect, it } from 'vitest';
import { calculateQuote, quoteCalculatorFields } from '../../scripts/g03/quote-calculator';
const base=()=>Object.fromEntries(quoteCalculatorFields.map(([name])=>[name,name==='quantity'?100:0]));
it('allocates fixed setup and reports per lot and cycle time per piece',()=>{
 const v={...base(),tm_setup:2,tm_minutes:6,material:10,treatment1:100,shipping1:50,reports:100,samples:50,tooling:100,added:2};
 const result=calculateQuote(v);expect(result.machining).toBe(6);expect(result.material).toBe(10);expect(result.treatment).toBe(1);expect(result.shipping).toBe(.5);expect(result.reports).toBe(4.5);expect(result.unit).toBe(22);expect(result.total).toBe(2200);
 expect(calculateQuote({...v,quantity:200}).unit).toBe(19.5);
});
it('matches the seven rates and optional VBA discounts without applying them',()=>{
 const v:Record<string,number>={...base(),quantity:1};for(const k of ['tm','tcnc','cv','ch','rec','oper','tec'])v[k+'_setup']=1;
 const r=calculateQuote(v);expect(r.unit).toBe(437);expect(r.discounts.map(d=>d.unit)).toEqual([437*.98,437*.97,437*.96]);
});
it('rejects missing, negative, infinite and fractional lot inputs',()=>{
 expect(()=>calculateQuote({...base(),quantity:0})).toThrow();expect(()=>calculateQuote({...base(),quantity:1.5})).toThrow();expect(()=>calculateQuote({...base(),material:NaN})).toThrow();expect(()=>calculateQuote({...base(),material:-1})).toThrow();expect(()=>calculateQuote({quantity:1})).toThrow();
});
