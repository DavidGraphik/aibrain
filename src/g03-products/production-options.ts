import type { Order } from './contracts';

/** One option per actual OF, ordered by number and suffix without changing identity. */
export function productionWorkOrders(orders:Pick<Order,'workOrder'>[]):string[] {
  return [...new Set(orders.map(order=>order.workOrder).filter((value):value is string=>!!value?.trim()))]
    .sort((a,b)=>a.localeCompare(b,'ca',{numeric:true,sensitivity:'base'}));
}
