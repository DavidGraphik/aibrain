import { useState } from 'react';
import { useLanguage } from '../context/LanguageContext.jsx';
import { entradaPara } from '../utils/shiftHours.js';

export default function ShiftEditModal({ employee, dia, shift, preference, onSave, onClose }) {
  const { t, getDays } = useLanguage();
  const DIAS_LABEL = getDays();

  const TURNOS = [
    { value: 'MANANA',  label: t('shift_morning'),   sublabel: t('shift_morning_sub'),   color: 'bg-blue-100 text-blue-800 border-blue-300' },
    { value: 'TARDE',   label: t('shift_afternoon'),  sublabel: t('shift_afternoon_sub'),  color: 'bg-orange-100 text-orange-800 border-orange-300' },
    { value: 'PARTIDO', label: t('shift_full_day'),   sublabel: t('shift_full_day_sub'),   color: 'bg-purple-100 text-purple-800 border-purple-300' },
    { value: 'LIBRE',   label: t('shift_free'),       sublabel: t('shift_free_sub'),       color: 'bg-gray-100 text-gray-600 border-gray-300' },
  ];

  const [turno, setTurnoRaw] = useState(shift?.turno || '');
  const [horaEntrada, setHoraEntrada] = useState(shift?.horaEntrada || '');
  const [horaDescanso, setHoraDescanso] = useState(shift?.horaDescanso || '');

  // Canviar el torn ha de descartar l'hora d'entrada que hi havia. Es guardava
  // tal com estava, i qui passava una tarda a matí es trobava el matí entrant
  // a les 14:45 — l'hora de la tarda que acabava de treure. Buida vol dir «la
  // que li toca», que la calcula `entradaPara` amb l'hora d'aquesta persona si
  // en té i la de la botiga si no.
  //
  // L'hora de descans només existeix per als PARTIDO, o sigui que en sortir-ne
  // sobra igual.
  function setTurno(nou) {
    if (nou !== turno) {
      // S'hi escriu l'hora que li toca en comptes de deixar-ho buit. Buit ja
      // funcionava —qui la desa sense hora acaba amb la que toca igualment—
      // però des del desplegable no es veia, i canviar de tarda a matí semblava
      // que hagués perdut l'hora.
      //
      // `entradaPara` mira primer l'hora d'aquesta persona i cau a la de la
      // botiga: si la Sandra té posat que entra a les 16:00, hi sortirà 16:00 i
      // no les 14:45 de tothom.
      setHoraEntrada(entradaPara(employee, nou) || '');
      // El descans només existeix als DIA.
      setHoraDescanso('');
    }
    setTurnoRaw(nou);
  }

  const [saving, setSaving] = useState(false);
  // Without this the server's refusal vanished and the modal sat on "Desant…"
  // for ever — a failed save looked exactly like a slow one.
  const [error, setError] = useState('');

  async function handleSave() {
    if (!turno) return;
    setSaving(true);
    setError('');
    try {
      await onSave({ turno, horaEntrada: horaEntrada || null, horaDescanso: horaDescanso || null });
    } catch (err) {
      setError(err?.response?.data?.error || t('error_saving'));
    } finally {
      setSaving(false);
    }
  }

  const isUnavailable = preference?.diasNoDisponible?.includes(dia);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            {employee.nombre} {employee.apellidos}
          </h3>
          <p className="text-sm text-gray-500">{DIAS_LABEL[dia]}</p>
          {isUnavailable && (
            <p className="mt-1 text-xs text-red-600 bg-red-50 rounded px-2 py-1">
              ⚠ {t('shift_unavailable')}
            </p>
          )}
          {preference?.turnoPreferido && (
            <p className="mt-1 text-xs text-blue-600 bg-blue-50 rounded px-2 py-1">
              {t('shift_prefers')} {preference.turnoPreferido.toLowerCase()}
            </p>
          )}
        </div>

        {/* Shift selector */}
        <div className="space-y-2 mb-4">
          {TURNOS.map((tItem) => (
            <button
              key={tItem.value}
              onClick={() => setTurno(tItem.value)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all text-left
                ${turno === tItem.value ? tItem.color + ' border-current' : 'border-gray-200 hover:border-gray-300'}
              `}
            >
              <span className="font-bold text-lg w-6">{tItem.label.split(' ')[0]}</span>
              <div>
                <p className="font-medium text-sm">{tItem.label.split(' — ')[1]}</p>
                <p className="text-xs opacity-60">{tItem.sublabel}</p>
              </div>
              {turno === tItem.value && <span className="ml-auto">✓</span>}
            </button>
          ))}
        </div>

        {/* Entry time */}
        {turno && turno !== 'LIBRE' && (
          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('shift_entry_time')}
            </label>
            <input
              type="time"
              value={horaEntrada}
              onChange={(e) => setHoraEntrada(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <p className="text-xs text-gray-400 mt-1">{t('shift_leave_empty')}</p>
          </div>
        )}

        {/* Break time */}
        {turno === 'PARTIDO' && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('shift_break_time')}
            </label>
            <input
              type="time"
              value={horaDescanso}
              onChange={(e) => setHoraDescanso(e.target.value)}
              min="13:00"
              max="15:00"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <p className="text-xs text-gray-400 mt-1">{t('shift_break_hint')}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-xl hover:bg-gray-50 transition-colors"
          >
            {t('cancel')}
          </button>
          {error && (
            <p className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
          <button
            onClick={handleSave}
            disabled={!turno || saving}
            className="flex-1 px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 disabled:opacity-40 text-white rounded-xl transition-colors font-medium"
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </div>
  );
}
