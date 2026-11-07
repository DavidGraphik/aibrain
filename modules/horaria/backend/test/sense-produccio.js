// ─────────────────────────────────────────────
// LES PROVES NO PODEN ARRIBAR A PRODUCCIÓ
//
// Es carrega abans de cada fitxer de proves (vegeu el script `test` del
// package.json), abans que res importi Prisma.
//
// El 12 d'agost, tres proves diferents del mateix dia van escriure a la base de
// dades de la botiga: una va crear dos treballadors, una altra va tocar un camp
// d'una persona real, i una tercera hauria esborrat establiments si una id
// hagués canviat. Les tres es van escriure amb la intenció de no tocar res, i
// les tres passaven en verd.
//
// «Ja aniré amb compte» no ha funcionat cap de les tres vegades, així que la
// protecció deixa de dependre de qui escriu la prova: aquí es canvia la
// connexió per una que no va enlloc. Una prova que arribi a Prisma peta amb un
// error de connexió en comptes d'escriure a la base de dades de l'empresa.
//
// Cap prova d'aquest projecte necessita base de dades. Si algun dia en cal una,
// ha de ser contra una branca de proves i posant-ho aquí explícitament, no
// deixant que caigui a la de producció per defecte.
// ─────────────────────────────────────────────
process.env.DATABASE_URL = 'postgresql://proves:proves@127.0.0.1:1/shiftai-proves-inexistent';
