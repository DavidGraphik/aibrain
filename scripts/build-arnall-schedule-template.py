"""Extract the original calculation model without carrying foreign records.

OOXML formula elements (including shared-formula anchors) are copied verbatim.
This lossless pass is required because a spreadsheet-library round trip rewrites
shared formulas/native features. It does not execute VBA or external queries.
"""
import argparse
import copy
import hashlib
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
N = {'m': M}
ET.register_namespace('', M)
ET.register_namespace('r', R)
ET.register_namespace('x14', 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main')
ET.register_namespace('xm', 'http://schemas.microsoft.com/office/excel/2006/main')

def tag(name): return '{' + M + '}' + name
def cells(sheet): return {c.get('r'): c for row in sheet.find('m:sheetData', N) for c in row}
def formula_map(sheet):
    return {a: {'attributes': dict(f.attrib), 'text': f.text} for a,c in cells(sheet).items() if (f := c.find('m:f', N)) is not None}
def clear(cell):
    assert cell.find('m:f', N) is None, 'Never clear a formula'
    for child in list(cell): cell.remove(child)
    cell.attrib.pop('t', None)
def write(cell, value):
    clear(cell)
    if value is None: return
    if isinstance(value, str):
        cell.set('t', 'inlineStr')
        ET.SubElement(ET.SubElement(cell,tag('is')),tag('t'),{'{http://www.w3.org/XML/1998/namespace}space':'preserve'}).text=value
    else: ET.SubElement(cell,tag('v')).text=str(value)
def text_value(cell):
    return ''.join(cell.find('m:is',N).itertext()) if cell is not None and cell.find('m:is',N) is not None else ''
def xml(root): return ET.tostring(root,encoding='unicode')

def extract(source, mode='blank'):
    with zipfile.ZipFile(source) as z:
        strings=[''.join(e.itertext()) for e in ET.fromstring(z.read('xl/sharedStrings.xml'))]
        source_sheets=[ET.fromstring(z.read(f'xl/worksheets/sheet{i}.xml')) for i in [3,40,41,44]]
        sheets=copy.deepcopy(source_sheets)
        originals=[formula_map(s) for s in source_sheets]
        source_names={strings[int(c.findtext('m:v',namespaces=N))] for a,c in cells(source_sheets[0]).items() if re.fullmatch(r'B(?:[6-9]|[1-8][0-9]|9[01])',a) and c.get('t')=='s'}
        tables=[]
        for table in ['table1.xml','table2.xml','table3.xml']:
            root=ET.fromstring(z.read('xl/tables/'+table))
            root.attrib.pop('tableType',None)
            for node in root.iter(): node.attrib.pop('queryTableFieldId',None)
            tables.append(root)
        for index,sheet in enumerate(sheets):
            for node in list(sheet):
                if node.tag.split('}')[-1] in ['drawing','legacyDrawing','AlternateContent']:
                    sheet.remove(node)
            sheet.attrib.clear()
            pr=sheet.find('m:sheetPr',N)
            if pr is not None: pr.attrib.pop('codeName',None)
            setup=sheet.find('m:pageSetup',N)
            if setup is not None: setup.attrib.pop('{'+R+'}id',None)
            for view in sheet.find('m:sheetViews',N):
                view.attrib.pop('tabSelected',None)
                if index==0: view.set('topLeftCell','B1')
                for selection in list(view): view.remove(selection)
            for address,cell in cells(sheet).items():
                f=cell.find('m:f',N)
                if f is not None:
                    # No old calculated personnel values survive in the package.
                    for child in list(cell):
                        if child.tag != tag('f'): cell.remove(child)
                    cell.attrib.pop('t',None)
                elif cell.get('t')=='s':
                    write(cell,strings[int(cell.findtext('m:v',namespaces=N))])
            if index>0:
                for row in sheet.find('m:sheetData',N):
                    number=int(row.get('r'))
                    if number==1: continue
                    row_cells={c.get('r'):c for c in row}
                    keep=mode=='baseline' or (mode=='scoped' and text_value(row_cells.get(f'A{number}')) in source_names)
                    for address,cell in row_cells.items():
                        if cell.find('m:f',N) is not None: continue
                        # O13 is workbook refresh metadata, not the person on row13.
                        metadata=(index==3 and address in ['O12','O13']) or (index==1 and address=='AB3')
                        if not keep and not metadata: clear(cell)
                        if mode=='blank' and address=='O13': clear(cell)
        main=cells(sheets[0])
        if mode=='blank':
            for address,cell in main.items():
                col=re.match('[A-Z]+',address)[0]; row=int(re.search(r'\d+',address)[0])
                if cell.find('m:f',N) is not None: continue
                if 6<=row<=91 and col in ['B','E','F','G','H','I','J','K','L','M','N','O','P','Q','R']:
                    clear(cell)
            for address in ['AZ101','BF101','BG101','BI101','L97']:
                if address in main: clear(main[address])
            for address,value in {'G4':'BOTIGA','W8':'LOCAL','X9':"A L’ALTRE LOCAL",'W15':'LOCAL','X14':"TARDA A UN ALTRE LOCAL",'X21':'PETICIÓ APROVADA','W26':'LOCAL 1','W27':'LOCAL 2'}.items():
                if address in main: write(main[address],value)
        # Retain only differential styles actually used, preserving their XML.
        styles=ET.fromstring(z.read('xl/styles.xml'))
        dxfs=styles.find('m:dxfs',N); used=[]; mapping={}; dedup={}
        for root in sheets+tables:
            for node in root.iter():
                for key in list(node.attrib):
                    if key.lower().endswith('dxfid'):
                        old=int(node.get(key))
                        if old not in mapping:
                            value=ET.tostring(dxfs[old])
                            if value not in dedup: dedup[value]=len(used);used.append(copy.deepcopy(dxfs[old]))
                            mapping[old]=dedup[value]
                        node.set(key,str(mapping[old]))
        dxfs[:]=used;dxfs.set('count',str(len(used)))
        for ext in styles.findall('m:extLst',N): styles.remove(ext)
        # ElementTree drops declarations referenced only by mc:Ignorable.
        # Keep that binding: Excel processes MCE even when a ZIP reader does not.
        if styles.get('{http://schemas.openxmlformats.org/markup-compatibility/2006}Ignorable') == 'x14ac':
            styles.set('xmlns:x14ac', 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac')
        names=['HORARI','TRACTES','VACANCES','PESONAL']
        workbook=ET.Element(tag('workbook'))
        ET.SubElement(ET.SubElement(workbook,tag('bookViews')),tag('workbookView'),{'activeTab':'0'})
        definitions=ET.SubElement(workbook,tag('sheets'))
        for i,name in enumerate(names,1):
            ET.SubElement(definitions,tag('sheet'),{'name':name,'sheetId':str(i),'{'+R+'}id':f'rId{i}',**({'state':'hidden'} if i>1 else {})})
        dn=ET.SubElement(workbook,tag('definedNames'))
        ET.SubElement(dn,tag('definedName'),{'name':'_xlnm.Print_Area','localSheetId':'0'}).text='HORARI!$B$1:$X$97'
        ET.SubElement(workbook,tag('calcPr'),{'calcId':'0','fullCalcOnLoad':'1','forceFullCalc':'1'})
        parts={'xl/workbook.xml':xml(workbook),'xl/styles.xml':xml(styles),'xl/theme/theme1.xml':z.read('xl/theme/theme1.xml').decode()}
        overrides=[('/xl/workbook.xml','spreadsheetml.sheet.main'),('/xl/styles.xml','spreadsheetml.styles'),('/xl/theme/theme1.xml','theme')]
        relationships=[f'<Relationship Id="rId{i}" Type="{R}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1,5)]
        relationships.extend([f'<Relationship Id="rId5" Type="{R}/styles" Target="styles.xml"/>',f'<Relationship Id="rId6" Type="{R}/theme" Target="theme/theme1.xml"/>'])
        for i,sheet in enumerate(sheets,1):
            parts[f'xl/worksheets/sheet{i}.xml']=xml(sheet)
            overrides.append((f'/xl/worksheets/sheet{i}.xml','spreadsheetml.worksheet'))
            if i>1:
                table_id=i-1
                tableparts=sheet.find('m:tableParts',N)
                relation_id=tableparts[0].get('{'+R+'}id')
                parts[f'xl/worksheets/_rels/sheet{i}.xml.rels']=f'<Relationships xmlns="{P}"><Relationship Id="{relation_id}" Type="{R}/table" Target="../tables/table{table_id}.xml"/></Relationships>'
                parts[f'xl/tables/table{table_id}.xml']=xml(tables[table_id-1])
                overrides.append((f'/xl/tables/table{table_id}.xml','spreadsheetml.table'))
        parts['xl/_rels/workbook.xml.rels']=f'<Relationships xmlns="{P}">'+''.join(relationships)+'</Relationships>'
        parts['_rels/.rels']=f'<Relationships xmlns="{P}"><Relationship Id="rId1" Type="{R}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
        parts['[Content_Types].xml']='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+''.join(f'<Override PartName="{p}" ContentType="application/vnd.openxmlformats-officedocument.{kind}+xml"/>' for p,kind in overrides)+'</Types>'
        for original,sheet in zip(originals,sheets): assert original==formula_map(sheet),'Formula parity failed'
        if mode=='blank':
            content='\n'.join(parts.values())
            for name in source_names: assert name not in content,name
            # Auxiliary tables contain headers, metadata labels and their one
            # original TODAY formula only, no employee/contact/financial rows.
            for i,sheet in enumerate(sheets[1:],1):
                for a,c in cells(sheet).items():
                    if int(re.search(r'\d+',a)[0])==1 or c.find('m:f',N) is not None or (i==3 and a=='O12') or (i==1 and a=='AB3'): continue
                    assert c.find('m:v',N) is None and c.find('m:is',N) is None,(i,a)
        stats={'sourceSha256':hashlib.sha256(Path(source).read_bytes()).hexdigest(),'formulaCount':sum(map(len,originals)),'scheduleFormulaCount':len(originals[0]),'formulaMaps':dict(zip(names,originals)),'mode':mode}
        return parts,stats

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('source',type=Path);parser.add_argument('output',type=Path)
    parser.add_argument('--parts',type=Path);parser.add_argument('--report',type=Path)
    parser.add_argument('--mode',choices=['blank','scoped','baseline'],default='blank')
    args=parser.parse_args()
    parts,stats=extract(args.source,args.mode)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(args.output,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,value in parts.items(): archive.writestr(name,value)
    if args.parts: args.parts.write_text(json.dumps(parts,ensure_ascii=False))
    if args.report: args.report.write_text(json.dumps(stats,ensure_ascii=False,indent=2))
    print(json.dumps({k:v for k,v in stats.items() if k!='formulaMaps'}))

if __name__=='__main__': main()
