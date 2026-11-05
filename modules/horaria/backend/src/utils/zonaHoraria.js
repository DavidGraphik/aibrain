// ─────────────────────────────────────────────
// L'HORA DE LA BOTIGA, NO LA DEL SERVIDOR
//
// Tot el cicle setmanal es calcula amb hores locals: la finestra obre diumenge
// a les 9 i tanca dimecres a la 1, i això surt de getHours() i getDay(). El
// Render, però, executa els contenidors en UTC per defecte.
//
// Amb el servidor en UTC, quan el cron truca a les 9:00 de Madrid el codi creu
// que són les 7:00 o les 8:00 i diu que la finestra encara no s'ha obert. El
// broadcast automàtic tornaria {enviats: 0, motiu: 'fora_de_finestra'} amb
// HTTP 200 — i com que és un 200, cron-job.org no envia el correu de job
// fallit, que és justament el segon canal d'avís per als dies que WhatsApp és
// el que no funciona. Ningú no rebria la petició de preferències i ningú
// s'assabentaria.
//
// Es fixa aquí, en codi, i no només com a variable al Render: així no depèn
// que algú se'n recordi el dia que es torni a desplegar en un altre lloc.
// Una TZ posada des de fora segueix manant, per si algun dia cal.
// ─────────────────────────────────────────────
// S'aplica en importar el mòdul, no en cridar una funció: els `import` d'ESM
// s'executen tots abans que cap línia solta del fitxer que els importa, o sigui
// que una crida seria massa tard si algun mòdul carregat pel camí ja hagués
// mirat l'hora. A index.js va just després de dotenv, perquè una TZ posada al
// .env o al Render segueixi manant sobre aquesta.
export const ZONA_PER_DEFECTE = 'Europe/Madrid';

export function zonaHoraria(env = process.env) {
  return env.TZ || ZONA_PER_DEFECTE;
}

process.env.TZ = zonaHoraria();
