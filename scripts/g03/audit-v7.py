"""Read-only workbook evidence. Never executes VBA, edits or recalculates the source."""
import argparse,collections,datetime,hashlib,json,pathlib,re,zipfile
import openpyxl
p=argparse.ArgumentParser();p.add_argument('workbook');p.add_argument('output');p.add_argument('--source-context',default='Local export; freshness must be confirmed against its owning source');a=p.parse_args()
source=pathlib.Path(a.workbook);out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True,mode=0o700)
f=openpyxl.load_workbook(source,data_only=False);v=openpyxl.load_workbook(source,data_only=True)
def encode(x):
 if isinstance(x,(datetime.datetime,datetime.date)):return x.isoformat()
 return str(x)
summary={'sourceHash':hashlib.sha256(source.read_bytes()).hexdigest(),'sourceName':source.name,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceFreshness':a.source_context,'sheets':[],'namedRanges':[{'name':n,'value':str(x)} for n,x in f.defined_names.items()]}
for s in f:
 cells=[];dependencies=set();functions=collections.Counter();errors=[]
 for row in s:
  for c in row:
   if c.value is None:continue
   value=v[s.title][c.coordinate]
   formula=c.value if c.data_type=='f' else None
   if formula:
    dependencies.update(re.findall(r"(?:'([^']+)'|([A-Z_ ]+))!",formula));functions.update(re.findall(r'([A-Z_][A-Z0-9_.]+)\(',formula))
   if value.data_type=='e':errors.append(c.coordinate)
   cells.append({'cell':c.coordinate,'formula':formula,'value':value.value,'format':c.number_format,'styleId':c.style_id,'comment':c.comment.text if c.comment else None})
 record={'name':s.title,'dimension':s.calculate_dimension(),'state':s.sheet_state,'nonemptyCells':len(cells),'formulaCells':sum(c['formula'] is not None for c in cells),'functions':dict(functions),'dependencies':sorted({a or b for a,b in dependencies}),'cachedErrorCells':errors,'mergedRanges':[str(x) for x in s.merged_cells.ranges],'validationRanges':[{'range':str(x.sqref),'type':x.type,'formula1':x.formula1,'formula2':x.formula2} for x in s.data_validations.dataValidation],'conditionalFormattingRules':sum(len(s.conditional_formatting[k]) for k in s.conditional_formatting),'freezePanes':str(s.freeze_panes),'autoFilter':s.auto_filter.ref}
 summary['sheets'].append(record)
 (out/f'sheet-{len(summary["sheets"]):02d}.json').write_text(json.dumps({'sheet':record,'cells':cells},ensure_ascii=False,indent=2,default=encode))
z=zipfile.ZipFile(source);summary['embeddedVbaParts']=[n for n in z.namelist() if 'vbaproject' in n.lower()];summary['drawingParts']=[n for n in z.namelist() if 'drawing' in n.lower() and n.endswith(('.xml','.vml'))];summary['scriptParity']='Not proven. XLSX export does not include bound Google Apps Script source or trigger configuration.'
s=w=f['CONTROL PRODUCCIÓ'];active=[r for r in range(29,s.max_row+1) if v[s.title][f'J{r}'].value]
summary['manualDerivedOverrides']=[{'cell':f'{c}{r}','field':k,'value':v[s.title][f'{c}{r}'].value} for k,c in {'unitsPending':'N','unitsAtG03':'R','materialMissing':'S','showInLoad':'W','loadText':'X','loadKey':'Y'}.items() for r in active if s[f'{c}{r}'].data_type!='f']
summary['totalFormulaCells']=sum(s['formulaCells'] for s in summary['sheets'])
(out/'manifest.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2,default=encode));print(json.dumps({'sheets':len(summary['sheets']),'formulas':summary['totalFormulaCells'],'manualOverrides':len(summary['manualDerivedOverrides']),'errorCells':sum(len(s['cachedErrorCells']) for s in summary['sheets'])}))
