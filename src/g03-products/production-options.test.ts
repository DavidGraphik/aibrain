import {expect,it} from 'vitest';
import {productionWorkOrders} from './production-options';

it('orders phase OF choices numerically, removes duplicates and excludes incomplete introductions',()=>{
  expect(productionWorkOrders(['559/5',null,'2/15','181/5','2/5','559/5','', '10/5'].map(workOrder=>({workOrder}))))
    .toEqual(['2/5','2/15','10/5','181/5','559/5']);
});
