"""Read-only import preparation; never executes VBA or rewrites source workbooks."""
import argparse, datetime as dt, hashlib, json, re
from decimal import Decimal
from pathlib import Path
import openpyxl

def number(v):
    if v is None or str(v).strip()=='': return None
    if isinstance(v,str): v=v.replace('€','').replace(' ','').replace('\xa0','').replace('.','').replace(',','.')
    return float(Decimal(str(v)))
def date(v):
    if not v:return None
    if isinstance(v,(dt.datetime,dt.date)):return v.strftime('%Y-%m-%d')
    for fmt in ('%d/%m/%Y','%d-%m-%Y','%Y-%m-%d'):
        try:return dt.datetime.strptime(str(v).strip(),fmt).strftime('%Y-%m-%d')
        except ValueError:pass
    raise ValueError(f'Unrecognized date: {v}')
def text(v):return None if v is None or str(v).strip()=='' else str(v).strip()
def rows(root,name,sheet,start):
    p=root/name; sha=hashlib.sha256(p.read_bytes()).hexdigest()
    w=openpyxl.load_workbook(p,read_only=True,data_only=True)
    try:
        for i,r in enumerate(w[sheet].iter_rows(values_only=True),1):
            if i>=start:yield i,r,sha
    finally:w.close()
def prepare(root):
    out={};issues=[]
    def prov(alias,sheet,row,sha):return dict(source_key=f'{alias}:{sheet}:{row}',source_sha256=sha,source_row=str(row),source_sheet=sheet)
    equip=[]
    for i,r,sha in rows(root,'equipment-2026.xlsx','06__FITXA APARELL',2):
        if not any(x is not None for x in r):continue
        equip.append(dict(code=text(r[2]),name=text(r[1]),location=text(r[6]),notes=text(r[12]),equipment_type=text(r[3]),equipment_subtype=text(r[4]),characteristics=text(r[5]),equipment_state=text(r[7]),dimension=text(r[8]),precision=text(r[9]),quantity=number(r[10]),source_updated=date(r[11]),last_date=None,next_date=None,source_image=text(r[13]),**prov('equipment-2026','06__FITXA APARELL',i,sha)))
        if not text(r[2]):issues.append(dict(kind='equipment_code_missing',row=i))
    out['Equips i calibracions']=equip
    nc=[];alternate={str(r[0]):r for i,r,sha in rows(root,'cost-incidents-2026-r1.xlsm','DATOS',2) if re.fullmatch(r'26\d{4}',str(r[0] or ''))}
    for i,r,sha in rows(root,'cost-incidents-2026-r1.xlsm','Maquinas',2):
        if not re.fullmatch(r'26\d{4}',str(r[0] or '')):continue
        alt=alternate.get(str(r[0])); changed=[]
        if alt:
            for j in (9,10,11):
                if number(r[j])!=number(alt[j]):changed.append(j)
        if changed:issues.append(dict(kind='nc_financial_conflict',code=str(r[0]),columns=changed))
        nc.append(dict(code=text(r[0]),kind=text(r[1]),reference=text(r[4]),opened=date(r[6]),description=text(r[5]),cause=text(r[8]),closed=None,cost=number(r[12]),client=text(r[3]),quantity=number(r[9]),pvp=number(r[10]),sales_value=number(r[11]),reconciliation='Pendent: quantitat o import diferent a DATOS' if changed else 'Sense diferència financera a DATOS' if alt else 'Només a Maquinas',source_data=json.dumps({'Maquinas':list(r[:13]),'DATOS':list(alt[:12]) if alt else None},default=str,ensure_ascii=False),**prov('cost-incidents-2026-r1','Maquinas',i,sha)))
    for i,r,sha in rows(root,'nonconformities-2026.xlsm','REGISTRO',3):
        if r[1] is None:continue
        nc.append(dict(code=text(r[1]),kind=text(r[10]),reference=text(r[2]),opened=date(r[12]),description=text(r[13]),closed=None,client=text(r[5]),quantity=number(r[11]),reconciliation='Registre històric separat; estat de tancament no informat',source_data=json.dumps(list(r[1:14]),default=str,ensure_ascii=False),**prov('nonconformities-2026','REGISTRO',i,sha)))
    out['Incidències de qualitat']=nc
    quotes=[]
    for i,r,sha in rows(root,'quotes-v13.xlsm','BASE_DATOS',3):
        if r[0] is None:continue
        quotes.append(dict(quote=text(r[0]),client=text(r[1]),reference=text(r[4]),quantity=number(r[38]),pvp=number(r[40]),quote_date=date(r[45]),description=text(r[5]),material=text(r[6]),notes='Preu original desat a BASE_DATOS. Sense recalcular macros ni afegir IVA.',source_data=json.dumps({openpyxl.utils.get_column_letter(j+1):v for j,v in enumerate(r) if v is not None and j not in (2,3,39)},default=str,ensure_ascii=False),**prov('quotes-v13','BASE_DATOS',i,sha)))
    out['Pressupostos per lots']=quotes
    assert len(equip)==373 and len(nc)==75 and len(quotes)==85
    for records in out.values():
        assert len({r['source_key'] for r in records})==len(records)
        assert all(not isinstance(v,str) or len(v)<=5000 for r in records for v in r.values())
    return dict(apps=out,issues=issues,notes=['69 expedients de Maquinas i 6 registres històrics; DATOS es conserva per conciliació, sense duplicar expedients.','El total acumulat original no coincideix amb totes les files; no es presenta com a total conciliat.','Dates de calibració i tancament desconegudes; no inferir-les de dates d’actualització.'])
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source_dir',type=Path);p.add_argument('output',type=Path);a=p.parse_args();result=prepare(a.source_dir)
    a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2));a.output.chmod(0o600)
    print(json.dumps({'counts':{k:len(v) for k,v in result['apps'].items()},'issues':len(result['issues'])}))
