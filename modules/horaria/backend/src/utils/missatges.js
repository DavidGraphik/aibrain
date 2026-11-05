// ─────────────────────────────────────────────
// THE WARNINGS, IN THE LANGUAGE OF WHOEVER IS READING
//
// Catalan and Spanish, because those are the two the shop uses. English is not
// here on purpose: writing a third version of every sentence for nobody to
// read is upkeep with no reader, and half-translating is worse than not — a
// Catalan sentence with English day names in it looks broken.
//
// Anything that is not Spanish falls back to Catalan, so a warning is never a
// mix of two languages.
// ─────────────────────────────────────────────

import { etiquetaTorn, etiquetaDia, llistaDies } from './etiquetes.js';

const CA = {
  diesFesta: (n, te) => `Li toquen ${n} dia/es de festa i en té ${te}`,
  nomesTardes: (m, p, L) => `Només ha de fer ${L('TARDE')}, i té ${m} de ${L('MANANA')} i ${p} de ${L('PARTIDO')}`,
  nomesMatins: (t, p, L) => `Només ha de fer ${L('MANANA')}, i té ${t} de ${L('TARDE')} i ${p} de ${L('PARTIDO')}`,
  restaMatins: (t, L) => `Fora dels torns de ${L('PARTIDO')} ha de fer ${L('MANANA')}, i té ${t} de ${L('TARDE')}`,
  maxTardes: (max, te, detall) => `Màxim ${max} tardes i en té ${te}${detall}`,
  detallTardes: (t, p, L) => ` (${t} de ${L('TARDE')} + ${p} de ${L('PARTIDO')})`,
  capPartit: (te, L) => `No ha de fer cap torn de ${L('PARTIDO')} i en té ${te}`,
  partitsExactes: (n, te, L) => `Li toquen ${n} torns de ${L('PARTIDO')} i en té ${te}`,
  partitsConsecutius: (L) => `Té dos torns de ${L('PARTIDO')} en dies consecutius`,
  matinsExactes: (n, te) => `Li toquen ${n} matins i en té ${te}`,
  tardesExactes: (n, te) => `Li toquen ${n} tardes i en té ${te}`,
  sincronitzat: (qui, dies) => `Ha de fer els mateixos matins que ${qui}, i no coincideixen: ${dies}`,
  sincronitzatSensePersona: (qui) => `Ha de fer els mateixos matins que ${qui}, i no s'ha trobat aquesta persona a la setmana`,
  senseFesta: (n, dies) => `No ha de fer festa entre setmana, i en té ${n} (${dies})`,
  condicional: (dA, tA, dB, permesos, real) => `Si el ${dA} fa ${tA}, el ${dB} ha de fer ${permesos}, i fa ${real}`,
  jornadaSenseFitxa: (h) => `Les condicions diuen jornada reduïda de ${h}h per torn, i la fitxa no en té cap posada`,
  jornadaDiferent: (h, real) => `Les condicions diuen ${h}h per torn i la fitxa en diu ${real}`,
  horaDiferent: (diu, fitxa) => `Les condicions diuen que entra a les ${diu} i la fitxa diu ${fitxa}`,
  noDisponible: (dia) => `Treballa el ${dia} i havia dit que no podia`,
  massesHores: (fetes, extra, objectiu) => `Té ${fetes}h${extra}, per sobre de l'objectiu de ${objectiu}`,
  poquesHores: (fetes, extra, objectiu) => `Té ${fetes}h${extra}, per sota de l'objectiu de ${objectiu}`,
  objectiuAjustat: (o, disp, total) => `${o}h (ajustat a ${disp}/${total} dies disponibles)`,
  objectiuIntensitat: (o, pct, contracte) => `${o}h (${pct}% de ${contracte}h)`,
  horesAltres: (aqui, altres) => ` (${aqui}h aquí + ${altres}h en altres botigues)`,
  condicioFixa: (m) => `Condició fixa: ${m}`,
  condicioSenseComprovar: (f) => `Condició fixa sense comprovar: "${f}"`,
  perPeticio: (m) => `Per petició seva: ${m}`,
  alternanca: (setmana, ant, toca, real) => `El dissabte de la ${setmana} va fer ${ant}, així que aquest li toca ${toca} i fa ${real}`,
  faltaGent: (dia, qui, torn, hi, cal) => `${dia}: falten ${qui} al torn de ${torn} (${hi}/${cal})`,
  sobraGent: (dia, qui, torn, hi, max) => `${dia}: sobren ${qui} al torn de ${torn} (${hi}/${max})`,
  dependentes: 'dependentes',
  obrador: "persones d'obrador",
};

const ES = {
  diesFesta: (n, te) => `Le tocan ${n} día(s) de fiesta y tiene ${te}`,
  nomesTardes: (m, p, L) => `Solo debe hacer ${L('TARDE')}, y tiene ${m} de ${L('MANANA')} y ${p} de ${L('PARTIDO')}`,
  nomesMatins: (t, p, L) => `Solo debe hacer ${L('MANANA')}, y tiene ${t} de ${L('TARDE')} y ${p} de ${L('PARTIDO')}`,
  restaMatins: (t, L) => `Fuera de los turnos de ${L('PARTIDO')} debe hacer ${L('MANANA')}, y tiene ${t} de ${L('TARDE')}`,
  maxTardes: (max, te, detall) => `Máximo ${max} tardes y tiene ${te}${detall}`,
  detallTardes: (t, p, L) => ` (${t} de ${L('TARDE')} + ${p} de ${L('PARTIDO')})`,
  capPartit: (te, L) => `No debe hacer ningún turno de ${L('PARTIDO')} y tiene ${te}`,
  partitsExactes: (n, te, L) => `Le tocan ${n} turnos de ${L('PARTIDO')} y tiene ${te}`,
  partitsConsecutius: (L) => `Tiene dos turnos de ${L('PARTIDO')} en días consecutivos`,
  matinsExactes: (n, te) => `Le tocan ${n} mañanas y tiene ${te}`,
  tardesExactes: (n, te) => `Le tocan ${n} tardes y tiene ${te}`,
  sincronitzat: (qui, dies) => `Debe hacer las mismas mañanas que ${qui}, y no coinciden: ${dies}`,
  sincronitzatSensePersona: (qui) => `Debe hacer las mismas mañanas que ${qui}, y no se ha encontrado a esa persona en la semana`,
  senseFesta: (n, dies) => `No debe tener fiesta entre semana, y tiene ${n} (${dies})`,
  condicional: (dA, tA, dB, permesos, real) => `Si el ${dA} hace ${tA}, el ${dB} debe hacer ${permesos}, y hace ${real}`,
  jornadaSenseFitxa: (h) => `Las condiciones dicen jornada reducida de ${h}h por turno, y la ficha no tiene ninguna`,
  jornadaDiferent: (h, real) => `Las condiciones dicen ${h}h por turno y la ficha dice ${real}`,
  horaDiferent: (diu, fitxa) => `Las condiciones dicen que entra a las ${diu} y la ficha dice ${fitxa}`,
  noDisponible: (dia) => `Trabaja el ${dia} y había dicho que no podía`,
  massesHores: (fetes, extra, objectiu) => `Tiene ${fetes}h${extra}, por encima del objetivo de ${objectiu}`,
  poquesHores: (fetes, extra, objectiu) => `Tiene ${fetes}h${extra}, por debajo del objetivo de ${objectiu}`,
  objectiuAjustat: (o, disp, total) => `${o}h (ajustado a ${disp}/${total} días disponibles)`,
  objectiuIntensitat: (o, pct, contracte) => `${o}h (${pct}% de ${contracte}h)`,
  horesAltres: (aqui, altres) => ` (${aqui}h aquí + ${altres}h en otras tiendas)`,
  condicioFixa: (m) => `Condición fija: ${m}`,
  condicioSenseComprovar: (f) => `Condición fija sin comprobar: "${f}"`,
  perPeticio: (m) => `A petición suya: ${m}`,
  alternanca: (setmana, ant, toca, real) => `El sábado de la ${setmana} hizo ${ant}, así que este le toca ${toca} y hace ${real}`,
  faltaGent: (dia, qui, torn, hi, cal) => `${dia}: faltan ${qui} en el turno de ${torn} (${hi}/${cal})`,
  sobraGent: (dia, qui, torn, hi, max) => `${dia}: sobran ${qui} en el turno de ${torn} (${hi}/${max})`,
  dependentes: 'dependientas',
  obrador: 'personas de obrador',
};

/**
 * The message set for a language, with the shift and day labels bound to it —
 * so a sentence and the words inside it can never come out in two languages.
 */
export function missatges(lang) {
  const es = String(lang || '').slice(0, 2).toLowerCase() === 'es';
  const idioma = es ? 'es' : 'ca';
  const base = es ? ES : CA;
  return {
    ...base,
    idioma,
    T: (t) => etiquetaTorn(t, idioma),
    D: (d) => etiquetaDia(d, idioma),
    dies: (ds) => llistaDies(ds, idioma),
  };
}
