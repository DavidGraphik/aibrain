import type { Order } from './contracts';

/** Only the four requested operational fields have expanded defaults. */
export const productionColumns: {key: keyof Order; label: string; width: number; type?: string}[] = [
  {key:'client',label:'Client',width:120,type:'readonly'}, {key:'reference',label:'Referència',width:130,type:'readonly'},
  {key:'description',label:'Descripció',width:180,type:'readonly'}, {key:'readyStock',label:'Estoc',width:72,type:'number'},
  {key:'productionStatus',label:'Estat',width:230}, {key:'statusComment',label:'Comentari',width:280},
  {key:'deliveryDate',label:'Entrega',width:136,type:'date'}, {key:'salesOrder',label:'Comanda',width:110},
  {key:'workOrder',label:'OF',width:90}, {key:'printStatus',label:'Impressió OF',width:110},
  {key:'units',label:'UD',width:72,type:'number'}, {key:'unitsDelivered',label:'Entreg.',width:72,type:'number'},
  {key:'unitsPending',label:'Pend.',width:72,type:'readonly'}, {key:'materialEta',label:'Mat. ETA',width:136,type:'date'},
  {key:'materialStatus',label:'Material',width:190}, {key:'unitsReceivedTotal',label:'Rebudes',width:80,type:'number'},
  {key:'unitsAtG03',label:'G03',width:72,type:'readonly'}, {key:'materialMissing',label:'Falta',width:72,type:'readonly'},
  {key:'assignedMachine',label:'Màquina',width:210}, {key:'priority',label:'Prio.',width:72,type:'number'},
];
export const MIN_COLUMN_WIDTH = 72, MAX_COLUMN_WIDTH = 1000;
export const PRODUCTION_FONT_FAMILIES = ['Arial','Calibri','Verdana','Tahoma','Helvetica'] as const;
export type ProductionFontFamily = typeof PRODUCTION_FONT_FAMILIES[number];
export const MIN_FONT_SIZE_PT = 8, MAX_FONT_SIZE_PT = 24;
export const isProductionFontFamily = (value: unknown): value is ProductionFontFamily => typeof value==='string' && (PRODUCTION_FONT_FAMILIES as readonly string[]).includes(value);
export const isProductionFontSize = (value: unknown): value is number => typeof value==='number' && Number.isFinite(value) && value>=MIN_FONT_SIZE_PT && value<=MAX_FONT_SIZE_PT && Number.isInteger(value*4);
export type ProductionView = { revision: number; columnWidths: Record<string, number>; layoutVersion?: number; fontFamily?: ProductionFontFamily; fontSizePt?: number };
const LAYOUT_VERSION = 2;
export const defaultProductionView = (): ProductionView => ({revision:0,layoutVersion:LAYOUT_VERSION,fontFamily:'Arial',fontSizePt:9.75,columnWidths:Object.fromEntries(productionColumns.map(c=>[c.key,c.width]))});
// Earlier saves materialized every default. Replace only those old defaults,
// leaving the four requested fields and all distinguishable personal sizes intact.
const legacyCompactDefaults: Record<string, number> = {
  client:150,reference:160,description:280,readyStock:85,deliveryDate:155,
  salesOrder:140,workOrder:120,printStatus:140,units:90,unitsDelivered:90,
  unitsPending:90,materialEta:155,unitsReceivedTotal:100,unitsAtG03:90,
  materialMissing:90,priority:85,
};
export function normalizeProductionView(saved: ProductionView | null): ProductionView {
  const defaults=defaultProductionView();
  const columnWidths={...defaults.columnWidths,...saved?.columnWidths};
  if(saved && (saved.layoutVersion??1)<LAYOUT_VERSION) {
    for(const [key,width] of Object.entries(legacyCompactDefaults)) {
      if(columnWidths[key]===width)columnWidths[key]=defaults.columnWidths[key];
    }
  }
  return {...defaults,...saved,layoutVersion:LAYOUT_VERSION,columnWidths,fontFamily:isProductionFontFamily(saved?.fontFamily)?saved.fontFamily:defaults.fontFamily,fontSizePt:isProductionFontSize(saved?.fontSizePt)?saved.fontSizePt:defaults.fontSizePt};
}
export const clampColumnWidth = (width: number) => Math.max(MIN_COLUMN_WIDTH,Math.min(MAX_COLUMN_WIDTH,Math.round(width)));
