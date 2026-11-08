"""Read-only V7 import. Preserve source rows and report ambiguities; never run macros."""
import argparse, collections, datetime as dt, hashlib, json, pathlib
import openpyxl
p=argparse.ArgumentParser();p.add_argument('workbook');p.add_argument('output');args=p.parse_args()
source=pathlib.Path(args.workbook);w=openpyxl.load_workbook(source,data_only=True);formulas=openpyxl.load_workbook(source,data_only=False)
issues=[]
def display(c,reference=False):
 v=c.value
 if v is None:return None
 if isinstance(v,dt.datetime):
  # Sheets stores several slash references as dates. Preserve their displayed value.
  fmt=c.number_format.lower()
  if 'yyyy' in fmt and ('m' in fmt):return f'{v.year}/{v.month}'
  if reference:issues.append(f'{c.parent.title}!{c.coordinate}: referència amb format de data ({c.number_format}); revisar.')
  return v.isoformat()
 if isinstance(v,float) and v.is_integer():return str(int(v))
 return str(v) if str(v).strip() else None
def day(v):return v.date().isoformat() if isinstance(v,dt.datetime) else (v.isoformat() if isinstance(v,dt.date) else None)
def num(v):
 if v is None or v=='':return None
 if isinstance(v,(int,float)):return v
 raise ValueError(f'Unexpected numeric source: {v}')
def orders(sheet,start,current):
 s=w[sheet];result=[]
 mapping={'client':'B','reference':'C','description':'D','readyStock':'E','productionStatus':'F','statusComment':'G','deliveryDate':'H','salesOrder':'I','workOrder':'J'}
 mapping.update(dict(zip(['printStatus','units','unitsDelivered','unitsPending','materialEta','materialStatus','unitsReceivedTotal','unitsAtG03','materialMissing','assignedMachine','priority','showInLoad','loadText','loadKey'], ['K','L','M','N','O','P','Q','R','S','U','V','W','X','Y'])) if current else dict(zip(['units','unitsDelivered','unitsPending','materialEta','materialStatus','unitsReceivedTotal','unitsAtG03','materialMissing','assignedMachine','priority','showInLoad','loadText','loadKey'],['K','L','M','N','O','P','Q','R','T','U','V','W','X'])))
 numbers={'readyStock','units','unitsDelivered','unitsPending','unitsReceivedTotal','unitsAtG03','materialMissing','priority'}
 for i in range(start,s.max_row+1):
  if not s[f'J{i}'].value:continue
  row={'rowNumber':i,'legacyFlag':None}
  if not current:
   row.update({k:day(s[f'{c}{i}'].value) if k=='deliveryDate' else num(s[f'{c}{i}'].value) if k=='readyStock' else display(s[f'{c}{i}']) for k,c in list(mapping.items())[:10]})
   row['units']=num(s[f'K{i}'].value) if isinstance(s[f'K{i}'].value,(int,float)) else num(s[f'L{i}'].value)
   row['sourceCells']={openpyxl.utils.get_column_letter(c.column):display(c) for c in s[i] if c.value is not None}
   result.append(row);continue
  for k,c in mapping.items():
   cell=s[f'{c}{i}'];
   if k in numbers and cell.value is not None and not isinstance(cell.value,(int,float)):raise ValueError(f'{sheet}!{cell.coordinate} {k}={cell.value}')
   row[k]=num(cell.value) if k in numbers else day(cell.value) if k in {'deliveryDate','materialEta'} else display(cell)
  if current:
   derived={'unitsPending':'N','unitsAtG03':'R','materialMissing':'S','showInLoad':'W','loadText':'X','loadKey':'Y'}
   ref=s[f'C{i}'];row['sourceReferenceValue']=str(int(openpyxl.utils.datetime.to_excel(ref.value))) if isinstance(ref.value,dt.datetime) else display(ref)
   row['formulaFields']=[]
   for k,col in derived.items():
    cell=formulas[sheet][f'{col}{i}']
    if cell.data_type=='f':
     expected=formulas[sheet][f'{col}29'].value.replace('29',str(i))
     if cell.value != expected:raise ValueError(f'{sheet}!{cell.coordinate}: fórmula diferent del model V7 verificat; revisió necessària')
     row['formulaFields'].append(k)
   for k in ['unitsAtG03','materialMissing']:
    if (row[k] or 0)<0:issues.append(f'{sheet} fila {i}, OF {row["workOrder"]}: {k} negatiu ({row[k]}), conservat del full; cal conciliar-lo.')
  result.append(row)
 return result
active=orders('CONTROL PRODUCCIÓ',29,True);history=orders('HISTÒRIC ENTREGATS',2,False)
for of,count in collections.Counter(o['workOrder'] for o in active).items():
 if count>1:issues.append(f'OF {of}: {count} línies amb referències diferents; es conserven separades per fila. Recepcions bloquejades fins a conciliar.')
phases=[];ofs={o['workOrder'] for o in active}
for i in range(3,w['FASES OF'].max_row+1):
 s=w['FASES OF'];wo=display(s[f'A{i}'])
 if not wo:continue
 phases.append(dict(rowNumber=i,workOrder=wo,phaseNumber=num(s[f'B{i}'].value),machine=display(s[f'C{i}']),state=display(s[f'D{i}']),priority=num(s[f'E{i}'].value),observations=display(s[f'F{i}'])))
 if wo not in ofs:issues.append(f'Fase fila {i}, OF {wo}: no consta entre les ordres actives; es conserva pendent de revisió.')
catalog=[]
for i in range(2,w['BASE DE DADES'].max_row+1):
 s=w['BASE DE DADES'];ref=display(s[f'A{i}'])
 if ref:catalog.append(dict(rowNumber=i,reference=ref,client=display(s[f'B{i}']),description=display(s[f'C{i}'])))
intake=[]
for row in w['INTRO COMANDES'].iter_rows(min_row=2):
 if row[0].value is not None:intake.append(dict(rowNumber=row[0].row,reference=display(row[0]),client=display(row[1]),description=display(row[2]),status=display(row[3])))
tasks=[];owner=''
for i in range(5,w['TASQUES '].max_row+1):
 s=w['TASQUES '];owner=display(s[f'D{i}']) or owner;description=display(s[f'E{i}'])
 if description:tasks.append(dict(rowNumber=i,owner=owner,description=description,done=False))
aux=w['LLISTES AUXILIARS'];machines={display(r[0]) for r in aux.iter_rows() if r[0].value};statuses={display(r[7]) for r in aux.iter_rows(min_row=2) if r[7].value}
machines.update(o['assignedMachine'] for o in active+history if o.get('assignedMachine'));machines.update(p['machine'] for p in phases if p['machine'])
statuses.update(o['productionStatus'] for o in active+history if o.get('productionStatus'))
snapshots=[]
for sheet in w:
 cells={}
 for row in sheet:
  for c in row:
   if c.value is None and formulas[sheet.title][c.coordinate].data_type!='f':continue
   value=c.value.isoformat() if isinstance(c.value,(dt.datetime,dt.date,dt.time)) else c.value
   fc=formulas[sheet.title][c.coordinate]
   cells[c.coordinate]={'value':value,'formula':fc.value if fc.data_type=='f' else None,'format':c.number_format}
 snapshots.append({'name':sheet.title,'dimension':sheet.calculate_dimension(),'cells':cells})
result=dict(sheets=snapshots,capturedAt=dt.datetime.now(dt.timezone.utc).isoformat(),spreadsheet={'title':'CONTROL PRODUCCIO V7'},sourceVersion='V7',sourceHash=hashlib.sha256(source.read_bytes()).hexdigest(),lookups={'machines':sorted(machines),'productionStatuses':sorted(statuses)},orders=active,phases=phases,intake=intake,catalog=catalog,deliveredHistory=history,tasks=tasks,importIssues=list(dict.fromkeys(issues)))
pathlib.Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({k:len(result[k]) for k in ['orders','phases','catalog','deliveredHistory','tasks','importIssues']}))
