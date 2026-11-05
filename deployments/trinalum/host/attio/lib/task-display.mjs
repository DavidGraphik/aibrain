const formatter = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const parts = value => Object.fromEntries(formatter.formatToParts(new Date(value)).map(p=>[p.type,p.value]));
export function taskText(task) {
  return String(task?.content_plaintext??'').split('\n').filter(line=>!/^Registro Trinalum: [A-Za-z0-9._:-]+$/.test(line.trim())).join('\n').trim();
}
export function taskDate(value) {
  if(!value)return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
  const p=parts(value);return `${p.year}-${p.month}-${p.day}`;
}
export function moveDeadline(date, previous=null) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid action date');
  const p=previous?parts(previous):{hour:'12',minute:'00',second:'00'};
  const wall=Date.parse(`${date}T${p.hour}:${p.minute}:${p.second}Z`);
  if(!Number.isFinite(wall)||new Date(wall).toISOString().slice(0,10)!==date)throw new Error('Invalid action date');
  let utc=wall;
  for(let i=0;i<3;i++){
    const x=parts(utc);const current=Date.parse(`${x.year}-${x.month}-${x.day}T${x.hour}:${x.minute}:${x.second}Z`);
    utc+=wall-current;
  }
  return new Date(utc).toISOString();
}
