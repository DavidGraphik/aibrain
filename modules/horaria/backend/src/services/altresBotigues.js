// ─────────────────────────────────────────────
// QUÈ TÉ AQUESTA PERSONA A LES ALTRES BOTIGUES
//
// El mapa desava TOTS els dies que la persona té desats en una altra botiga,
// festes incloses, i qui el consulta ho fa amb `if (mapa[dia])` — un objecte
// sempre és cert. O sigui que algú que a l'altra botiga té FESTA constava aquí
// com a ocupat, i el motor no li podia assignar res aquell dia.
//
// L'efecte no era només perdre un dia: `diasNoDisponibles` compta aquests dies
// per encongir l'objectiu d'hores, així que a més se li retallaven les hores de
// la setmana sense cap motiu.
//
// Una FESTA que ha demanat la persona SÍ que s'ha de respectar, però d'això ja
// se n'encarrega un altre mecanisme: les preferències es carreguen per persona i
// setmana, no per botiga, i `forcePreferenceDaysOff` força la festa en
// qualsevol botiga que generi. No cal mirar què va fer l'altra.
//
// Una FESTA que ha decidit el quadre, en canvi, no és de ningú: si l'altra
// botiga no la necessita aquell dia, aquesta sí que la pot fer treballar.
// ─────────────────────────────────────────────

import { shiftHours } from '../utils/shiftHours.js';

/**
 * @param {Array} torns  Torns d'aquesta persona en ALTRES botigues, la mateixa
 *                       setmana. Cada torn porta `empleado` (per calcular les
 *                       hores) i `establecimiento`.
 * @returns {Object} empleadoId → { hours, days: { LUNES: {establecimiento, turno} } }
 */
export function ocupacioAltresBotigues(torns) {
  const mapa = {};
  for (const s of torns || []) {
    if (!mapa[s.empleadoId]) mapa[s.empleadoId] = { hours: 0, days: {} };
    // Les hores sí que compten totes: una FESTA en suma zero, i el que importa
    // és quantes n'ha fet ja per saber quantes li queden.
    mapa[s.empleadoId].hours += shiftHours(s.empleado, s.turno);

    // Els dies, només els que de debò l'ocupen.
    if (s.turno && s.turno !== 'LIBRE') {
      mapa[s.empleadoId].days[s.dia] = {
        establecimiento: s.establecimiento?.nombre,
        turno: s.turno,
      };
    }
  }
  return mapa;
}
