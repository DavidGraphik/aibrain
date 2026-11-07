import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { validateDataset, machineQueue } from './contracts';
const source=()=>({sourceVersion:'V7',capturedAt:'2026-10-07T10:00:00Z',lookups:{machines:['M1'],productionStatuses:['ENTREGAT']},orders:[{rowNumber:29,workOrder:'588/5',reference:'2108/1',units:20,unitsDelivered:5,unitsAtG03:-5,materialMissing:-3,printStatus:'FET',productionStatus:'ENTREGAT',assignedMachine:'M1'},{rowNumber:30,workOrder:'588/5',reference:'2801/7',units:10}],phases:[],deliveredHistory:[{rowNumber:3,workOrder:'H1',reference:'2108/1',units:5,sourceCells:{B:'Client',K:'5'}}],tasks:[{rowNumber:3,owner:'Jordi',description:'Revisar',done:false}]});
describe('V7 source preservation',()=>{
 it('retains duplicate identifiers by distinct source row and signed source balances',()=>{const d=validateDataset(source());expect(d.orders).toHaveLength(2);expect(d.orders[0]).toMatchObject({reference:'2108/1',printStatus:'FET',unitsAtG03:-5,materialMissing:-3,unitsPending:15});expect(d.deliveredHistory?.[0].sourceCells).toEqual({B:'Client',K:'5'});expect(machineQueue(d,'M1').map(r=>r.id)).toEqual(['of-29']);});
 it('does not permit signed balances for other source formats',()=>{expect(()=>validateDataset({...source(),sourceVersion:'V6'})).toThrow();});
 it('rejects nonfinite source quantities, malformed history and orphan phases',()=>{const d=source();d.orders[0].unitsAtG03=-Infinity;expect(()=>validateDataset(d)).toThrow();expect(()=>validateDataset({...source(),deliveredHistory:[{rowNumber:1,units:'bad'}]})).toThrow();expect(()=>validateDataset({...source(),phases:[{rowNumber:1,workOrder:'missing'}]})).toThrow();});
});
