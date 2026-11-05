"""Generate fictional legacy fixtures; development only: xlwt==1.3.0."""
import datetime
from pathlib import Path
import xlwt

root=Path(__file__).resolve().parent
book=xlwt.Workbook()
sheet=book.add_sheet('Operación')
sheet.write(0,0,'Proveedor ficticio')
sheet.write(0,1,12.5)
sheet.write(1,1,7.25)
sheet.write(0,2,datetime.datetime(2026,9,2),xlwt.easyxf(num_format_str='YYYY-MM-DD'))
sheet.write(0,3,True)
sheet.row(0).set_cell_error(4,'#DIV/0!')
sheet.write(0,5,xlwt.Formula('SUM(B1:B2)'))
sheet.write(0,6,0.0000001)
second=book.add_sheet('Personas')
second.write(0,0,'Nombre de ejemplo: Núria')
book.save(str(root/'knowledge-legacy.xls'))
secret=xlwt.Workbook()
secret.add_sheet('Example').write(0,0,'password=abcdefghijklmnopqrstuvwx')
secret.save(str(root/'knowledge-legacy-secret.xls'))
