import {expect,it} from 'vitest';
import type {Order} from './contracts';
import {deliveryPeriod,productionCellAppearance,defaultDeliveryColors} from './production-appearance';
it('matches Jordi’s delivery legend including the seven day boundary and month/year changes',()=>{
  const today='2026-10-22';
  expect(deliveryPeriod('2026-10-21',today)).toBe('overdue');
  expect(deliveryPeriod(today,today)).toBe('week');
  expect(deliveryPeriod('2026-10-29',today)).toBe('week');
  expect(deliveryPeriod('2026-10-30',today)).toBe('currentMonth');
  expect(deliveryPeriod('2026-11-01',today)).toBe('futureMonth');
  expect(deliveryPeriod('2027-01-01','2026-12-28')).toBe('week');
  expect(deliveryPeriod('2027-01-10','2026-12-28')).toBe('futureMonth');
});
it('applies persisted cell overrides before delivery defaults and keeps text readable',()=>{
  const order={deliveryDate:'2026-10-20',productionStatus:null} as Order;
  expect(productionCellAppearance(order,'deliveryDate','2026-10-22')).toMatchObject({backgroundColor:defaultDeliveryColors.overdue});
  expect(productionCellAppearance(order,'productionStatus','2026-10-22')).toBeUndefined();
  expect(productionCellAppearance(order,'productionStatus','2026-10-22',{cellColors:{productionStatus:{'':'#FFFFFF'}}})).toEqual({backgroundColor:'#FFFFFF',color:'#18232D'});
  expect(productionCellAppearance(order,'deliveryDate','2026-10-22',{deliveryColors:{overdue:'#000000'}})).toEqual({backgroundColor:'#000000',color:'#FFFFFF'});
  expect(productionCellAppearance(order,'deliveryDate','2026-10-22',{cellColors:{deliveryDate:{'2026-10-20':'#FFFFFF'}}})).toMatchObject({backgroundColor:'#FFFFFF'});
});

it('colors material ETA red when overdue, yellow through seven days and green thereafter including this month',()=>{
  const today='2026-10-22';
  for(const [materialEta,color] of [['2026-10-21','overdue'],[today,'week'],['2026-10-29','week'],['2026-10-30','futureMonth'],['2026-11-02','futureMonth']] as const){
    expect(productionCellAppearance({materialEta} as Order,'materialEta',today)).toMatchObject({backgroundColor:defaultDeliveryColors[color]});
  }
  expect(productionCellAppearance({materialEta:null} as Order,'materialEta',today)).toBeUndefined();
  expect(productionCellAppearance({materialEta:'2026-10-30'} as Order,'materialEta',today,{cellColors:{materialEta:{'2026-10-30':'#123456'}}})).toMatchObject({backgroundColor:'#123456'});
  expect(productionCellAppearance({materialEta:'2026-10-30'} as Order,'materialEta',today,{deliveryColors:{futureMonth:'#abcdef'}})).toMatchObject({backgroundColor:'#abcdef'});
});
it('matches the requested production status legend while preserving configured colors and blank cells',()=>{
  for(const [productionStatus,backgroundColor,color] of [['NO COMENÇAT','#000000','#FFFFFF'],['EXTERN','#D9D2E9','#18232D'],['EN PRODUCCIÓ','#FFFF00','#18232D']]){
    const order={productionStatus} as Order;
    expect(productionCellAppearance(order,'productionStatus','2026-10-23')).toEqual({backgroundColor,color});
    expect(productionCellAppearance(order,'productionStatus','2026-10-23',{cellColors:{productionStatus:{[productionStatus]:'#123456'}}})).toEqual({backgroundColor:'#123456',color:'#FFFFFF'});
  }
  expect(productionCellAppearance({productionStatus:''} as Order,'productionStatus','2026-10-23')).toBeUndefined();
});

it('reads unambiguous legacy dropdown color keys while exact canonical colors take priority',()=>{
 const order={materialStatus:'PENDENT'} as Order;
 expect(productionCellAppearance(order,'materialStatus','2026-10-28',{cellColors:{materialStatus:{'PENDENT ':'#FF0000'}}})).toMatchObject({backgroundColor:'#FF0000'});
 expect(productionCellAppearance(order,'materialStatus','2026-10-28',{cellColors:{materialStatus:{'PENDENT ':'#FF0000',PENDENT:'#00FF00'}}})).toMatchObject({backgroundColor:'#00FF00'});
 expect(productionCellAppearance(order,'materialStatus','2026-10-28',{cellColors:{materialStatus:{'PENDENT ':'#FF0000',' pendent':'#00FF00'}}})).toBeUndefined();
 expect(productionCellAppearance({reference:'REF'} as Order,'reference','2026-10-28',{cellColors:{reference:{'REF ':'#FF0000'}}})).toBeUndefined();
});
