import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useLanguage } from '../context/LanguageContext.jsx';
import client, { getCached } from '../api/client.js';
import ImportEmployeesModal from '../components/ImportEmployeesModal.jsx';

const DIAS_GRID = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

// Build a fully-available grid { LUNES: {M:true,T:true}, ... }
function fullAvailability() {
  return DIAS_GRID.reduce((acc, d) => ({ ...acc, [d]: { M: true, T: true } }), {});
}
// Parse the stored JSON (or null = fully available)
function parseAvailability(str) {
  if (!str) return fullAvailability();
  try {
    const obj = typeof str === 'string' ? JSON.parse(str) : str;
    return DIAS_GRID.reduce((acc, d) => ({
      ...acc,
      [d]: { M: obj?.[d]?.M !== false, T: obj?.[d]?.T !== false },
    }), {});
  } catch {
    return fullAvailability();
  }
}

export default function Employees() {
  const { state: arribada } = useLocation();
  const { isManagerGeneral } = useAuth();
  const { t } = useLanguage();
  const [employees, setEmployees] = useState([]);
  const [establecimientos, setEstablecimientos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState({}); // { estId: true/false }
  const [showImport, setShowImport] = useState(false);

  const ROL_LABEL = { EMPLEADO: t('role_employee'), MANAGER_LOCAL: t('role_manager_local'), MANAGER_GENERAL: t('role_manager_general') };

  function defaultForm() {
    return {
      nombre: '', apellidos: '', email: '', password: '',
      telefonoWhatsapp: '', rol: 'EMPLEADO', funcion: 'DEPENDIENTA',
      establecimientoId: '', flexible: false, maxHorasSemana: 40,
      horasPorTurno: '', horaEntradaManana: '', horaEntradaTarde: '',
      otrosEstablecimientos: [],
      disponibilidad: fullAvailability(), condicionesFijas: '', condicionesEstructuradas: null,
    };
  }

  useEffect(() => {
    Promise.all([getCached('/employees'), getCached('/establishments')])
      .then(([e, est]) => { setEmployees(e.data); setEstablecimientos(est.data); })
      .finally(() => setLoading(false));
    // Arriving from the front page's "new employee" action: open the form,
    // don't drop the manager on the list to hunt for the button again.
    if (arribada?.obrir === 'nou') openCreate();
  }, []);

  // Group employees by establishment
  function getGroups() {
    const groups = [];
    const estMap = {};

    // Create a group per establishment
    for (const est of establecimientos) {
      estMap[est.id] = { est, employees: [] };
    }

    // Also a group for unassigned
    const unassigned = { est: null, employees: [] };

    // Whoever runs the whole chain belongs to no shop, so they fell through
    // every group and were skipped — which left their phone unreachable from
    // the app, and that phone is what the Monday reminder and the "everybody
    // has answered" notice are sent to.
    const generals = employees.filter((e) => e.rol === 'MANAGER_GENERAL');

    for (const emp of employees) {
      if (emp.rol === 'MANAGER_GENERAL') continue;
      const estId = emp.establecimiento?.id;
      if (estId && estMap[estId]) {
        estMap[estId].employees.push(emp);
      } else {
        unassigned.employees.push(emp);
      }
    }

    // Sort employees within each group by apellidos
    for (const id of Object.keys(estMap)) {
      estMap[id].employees.sort((a, b) =>
        `${a.apellidos} ${a.nombre}`.localeCompare(`${b.apellidos} ${b.nombre}`)
      );
      if (estMap[id].employees.length > 0) {
        groups.push(estMap[id]);
      }
    }

    if (generals.length > 0) {
      generals.sort((a, b) => `${a.apellidos} ${a.nombre}`.localeCompare(`${b.apellidos} ${b.nombre}`));
      groups.unshift({ est: null, general: true, employees: generals });
    }

    if (unassigned.employees.length > 0) {
      unassigned.employees.sort((a, b) =>
        `${a.apellidos} ${a.nombre}`.localeCompare(`${b.apellidos} ${b.nombre}`)
      );
      groups.push(unassigned);
    }

    return groups;
  }

  function toggleGroup(key) {
    // El `?? true` ha de ser el mateix que el de baix: si aquí es partís de
    // `!undefined`, el primer toc sobre un grup que ja es veu plegat el tornaria
    // a marcar com a plegat i semblaria que el botó no fa res.
    setCollapsed((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  }

  function openCreate() {
    setEditing(null); setForm(defaultForm()); setError(''); setShowForm(true);
  }

  function openEdit(emp) {
    setEditing(emp.id);
    setForm({
      nombre: emp.nombre, apellidos: emp.apellidos,
      email: emp.email || '', password: '',
      telefonoWhatsapp: emp.telefonoWhatsapp || '',
      rol: emp.rol, funcion: emp.funcion,
      establecimientoId: String(emp.establecimiento?.id || ''),
      flexible: emp.flexible, maxHorasSemana: emp.maxHorasSemana ?? 40,
      horasPorTurno: emp.horasPorTurno ?? '', horaEntradaManana: emp.horaEntradaManana ?? '', horaEntradaTarde: emp.horaEntradaTarde ?? '',
      otrosEstablecimientos: (emp.establecimientosPermitidos || []).map((e) => e.establishment.id),
      disponibilidad: parseAvailability(emp.disponibilidad),
      condicionesFijas: emp.condicionesFijas || '',
      condicionesEstructuradas: emp.condicionesEstructuradas || null,
    });
    setError(''); setShowForm(true);
  }

  function toggleAvail(dia, slot) {
    setForm((f) => ({
      ...f,
      disponibilidad: { ...f.disponibilidad, [dia]: { ...f.disponibilidad[dia], [slot]: !f.disponibilidad[dia][slot] } },
    }));
  }

  // La traducció que s'està mirant ara. No es desa fins que no es prem el botó
  // d'acceptar-la: ningú ha de donar per bona una traducció que no ha vist.
  const [traduint, setTraduint] = useState(false);
  const [traduccio, setTraduccio] = useState(null);

  async function comprovaCondicions() {
    setTraduint(true);
    setTraduccio(null);
    try {
      const { data } = await client.post(`/employees/${editing}/condicions/tradueix`, {
        texto: form.condicionesFijas,
      });
      setTraduccio(data);
    } catch (err) {
      setTraduccio({ ok: false, errors: [err.response?.data?.error || t('error_saving')] });
    } finally {
      setTraduint(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    try {
      const payload = {
        ...form,
        establecimientoId: form.establecimientoId ? parseInt(form.establecimientoId) : null,
        maxHorasSemana: parseInt(form.maxHorasSemana) || 40,
        horasPorTurno: form.horasPorTurno === '' ? null : parseInt(form.horasPorTurno),
        horaEntradaManana: form.horaEntradaManana || null,
        horaEntradaTarde: form.horaEntradaTarde || null,
        flexible: form.otrosEstablecimientos.length > 0 ? true : form.flexible,
      };
      delete payload.otrosEstablecimientos;
      // Credentials only apply to managers; never persist them for a regular employee
      const isManagerRole = form.rol === 'MANAGER_LOCAL' || form.rol === 'MANAGER_GENERAL';
      if (!isManagerRole) {
        payload.email = null;
        delete payload.password;
      } else if (!payload.password) {
        delete payload.password;
      }

      if (editing) {
        const { data } = await client.put(`/employees/${editing}`, payload);
        await client.put(`/employees/${editing}/allowed-establishments`, {
          establishmentIds: form.otrosEstablecimientos,
        });
        setEmployees((prev) => prev.map((emp) => emp.id === editing
          ? { ...emp, ...data, establecimientosPermitidos: form.otrosEstablecimientos.map((id) => ({ establishment: establecimientos.find((e) => e.id === id) || { id, nombre: '' } })) }
          : emp
        ));
      } else {
        const { data } = await client.post('/employees', payload);
        if (form.otrosEstablecimientos.length > 0) {
          await client.put(`/employees/${data.id}/allowed-establishments`, {
            establishmentIds: form.otrosEstablecimientos,
          });
        }
        setEmployees((prev) => [...prev, { ...data, establecimientosPermitidos: [] }]);
      }
      setShowForm(false);
    } catch (err) {
      setError(err.response?.data?.error || t('error_saving'));
    }
  }

  function toggleOtroEst(id) {
    setForm((prev) => ({
      ...prev,
      otrosEstablecimientos: prev.otrosEstablecimientos.includes(id)
        ? prev.otrosEstablecimientos.filter((x) => x !== id)
        : [...prev.otrosEstablecimientos, id],
    }));
  }

  async function handleDeactivate(id) {
    if (!window.confirm(t('emp_confirm_deactivate'))) return;
    await client.delete(`/employees/${id}`);
    setEmployees((prev) => prev.filter((e) => e.id !== id));
  }

  if (loading) return <div className="p-4 sm:p-6 text-gray-500 text-sm">{t('loading')}</div>;

  const groups = getGroups();

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{t('emp_title')}</h2>
          <p className="text-sm text-gray-500">{employees.length} {t('emp_title').toLowerCase()}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowImport(true)} className="border border-gray-300 hover:bg-gray-50 text-gray-700 text-xs sm:text-sm font-medium px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg transition-colors">
            {t('emp_import')}
          </button>
          <button onClick={openCreate} className="bg-primary-600 hover:bg-primary-700 text-white text-xs sm:text-sm font-medium px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg transition-colors">
            {t('emp_new')}
          </button>
        </div>
      </div>

      {showImport && (
        <ImportEmployeesModal
          establecimientos={establecimientos}
          establecimientoId={sessionStorage.getItem('shiftai_est') || groups.find((g) => g.est)?.est?.id}
          onClose={() => setShowImport(false)}
          onImported={() => client.get('/employees').then(({ data }) => setEmployees(data))}
        />
      )}

      <div className="space-y-4">
        {groups.map((group) => {
          const key = group.general ? 'general' : group.est ? group.est.id : 'unassigned';
          // Sense res dit, plegat. Amb tres botigues i 79 persones, obert de
          // sèrie volia dir arrencar amb una llista d'una pantalla i mitja per
          // trobar-hi ningú. El `??` és el que ho fa: no és el mateix «encara
          // no l'ha tocat» que «l'ha obert».
          const isCollapsed = collapsed[key] ?? true;
          const groupName = group.general
            ? t('emp_general_group')
            : group.est ? group.est.nombre : t('emp_unassigned');
          const count = group.employees.length;

          return (
            <div key={key} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {/* Group header — clickable to collapse/expand */}
              <button
                onClick={() => toggleGroup(key)}
                className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-gray-800">{groupName}</span>
                  <span className="text-[11px] font-medium bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                    {count}
                  </span>
                  {group.est?.managerLocal && (
                    <span className="text-[11px] text-gray-400">
                      {t('est_manager')}: {group.est.managerLocal.nombre} {group.est.managerLocal.apellidos}
                    </span>
                  )}
                </div>
                <span className="text-gray-400 text-sm">{isCollapsed ? '▼' : '▲'}</span>
              </button>

              {/* Employee table — shown when not collapsed */}
              {!isCollapsed && (
                <div className="overflow-x-auto">
                <table className="min-w-full text-sm border-t border-gray-100 whitespace-nowrap">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-5 py-2 font-medium text-gray-500 text-xs">{t('name')}</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">{t('emp_function')}</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">WhatsApp</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">{t('emp_role')}</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">{t('dash_hours')}</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {group.employees.map((emp) => (
                      <tr key={emp.id} className="hover:bg-gray-50 group">
                        <td className="px-5 py-2.5">
                          <p className="font-medium text-gray-800">{emp.nombre} {emp.apellidos}</p>
                          {emp.establecimientosPermitidos?.length > 0 && (
                            <p className="text-[10px] text-primary-500 mt-0.5">
                              +{emp.establecimientosPermitidos.length} {t('emp_more')}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                            emp.funcion === 'DEPENDIENTA'
                              ? 'bg-blue-50 text-blue-600'
                              : 'bg-green-50 text-green-600'
                          }`}>
                            {emp.funcion === 'DEPENDIENTA' ? t('func_dependienta') : t('func_elaboracion')}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs font-mono">{emp.telefonoWhatsapp || '—'}</td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{ROL_LABEL[emp.rol]}</td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{emp.maxHorasSemana}h</td>
                        <td className="px-4 py-2.5 text-right space-x-2">
                          <button onClick={() => openEdit(emp)} className="text-xs text-blue-600 hover:underline opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">{t('edit')}</button>
                          {isManagerGeneral() && (
                            <button onClick={() => handleDeactivate(emp.id)} className="text-xs text-red-500 hover:underline opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">{t('emp_deactivate')}</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Employee form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {editing ? t('emp_edit_title') : t('emp_new_title')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('name')}</label>
                  <input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_surname')}</label>
                  <input value={form.apellidos} onChange={(e) => setForm({ ...form, apellidos: e.target.value })} required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              </div>
              {isManagerGeneral() && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_role')}</label>
                  <select value={form.rol} onChange={(e) => setForm({ ...form, rol: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                    <option value="EMPLEADO">{t('role_employee')}</option>
                    <option value="MANAGER_LOCAL">{t('role_manager_local')}</option>
                    <option value="MANAGER_GENERAL">{t('role_manager_general')}</option>
                  </select>
                </div>
              )}
              {/* Login credentials only apply to managers — regular employees interact via WhatsApp only */}
              {(form.rol === 'MANAGER_LOCAL' || form.rol === 'MANAGER_GENERAL') && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">{t('email')}</label>
                    <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_password')} {editing && `(${t('emp_password_hint')})`}</label>
                    <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={!editing} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                  </div>
                </>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_phone')}</label>
                <input value={form.telefonoWhatsapp} onChange={(e) => setForm({ ...form, telefonoWhatsapp: e.target.value })} placeholder="+34600000000" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_function')}</label>
                  <select value={form.funcion} onChange={(e) => setForm({ ...form, funcion: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                    <option value="DEPENDIENTA">{t('func_dependienta')}</option>
                    <option value="ELABORACION">{t('func_elaboracion')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_hours_week')}</label>
                  <input type="number" min="1" max="60" value={form.maxHorasSemana} onChange={(e) => setForm({ ...form, maxHorasSemana: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              </div>

              {/* Reduced working day — only for part-timers with a fixed block */}
              <div className="border border-gray-200 rounded-lg p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    id="jornadaReducida"
                    checked={form.horasPorTurno !== ''}
                    onChange={(e) => setForm({
                      ...form,
                      // Suggest the obvious split for a five-day week; the manager
                      // can override it. Guessing silently would be worse: these
                      // hours end up on the payroll.
                      horasPorTurno: e.target.checked
                        ? String(Math.max(1, Math.round((parseInt(form.maxHorasSemana) || 40) / 5)))
                        : '',
                    })}
                    className="mt-0.5"
                  />
                  <label htmlFor="jornadaReducida" className="text-xs text-gray-700">
                    <span className="font-medium">{t('emp_reduced_day')}</span>
                    <span className="block text-gray-500">{t('emp_reduced_day_hint')}</span>
                  </label>
                </div>
                {form.horasPorTurno !== '' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_hours_shift')}</label>
                    <input type="number" min="1" max="10" value={form.horasPorTurno}
                      onChange={(e) => setForm({ ...form, horasPorTurno: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                  </div>
                )}
              </div>

              {/* Les hores d'entrada, FORA del bloc de la jornada reduïda.
                  Hi estaven a dins, i desmarcar la casella a més les esborrava:
                  qui fa jornada completa no les podia tenir. La Sandra fa 40h i
                  entra a les 16:00, i per posar-l'hi calia marcar-la com a
                  reduïda —que és mentida i li canvia el càlcul d'hores— o no
                  posar-l'hi. No s'hi va posar mai, i cada generació li donava
                  les 14:45 de tothom. Entrar més tard no té res a veure amb
                  fer menys hores. */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_entry_morning')}</label>
                  <input type="time" value={form.horaEntradaManana} placeholder="07:30"
                    onChange={(e) => setForm({ ...form, horaEntradaManana: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                  <p className="text-[11px] text-gray-400 mt-1">{t('emp_entry_hint')}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_entry_afternoon')}</label>
                  <input type="time" value={form.horaEntradaTarde} placeholder="14:45"
                    onChange={(e) => setForm({ ...form, horaEntradaTarde: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                  <p className="text-[11px] text-gray-400 mt-1">{t('emp_entry_hint')}</p>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_main_est')}</label>
                <select value={form.establecimientoId} onChange={(e) => setForm({ ...form, establecimientoId: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                  <option value="">{t('emp_unassigned')}</option>
                  {establecimientos.map((est) => <option key={est.id} value={est.id}>{est.nombre}</option>)}
                </select>
              </div>
              {establecimientos.filter((e) => String(e.id) !== form.establecimientoId).length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('emp_also_works')}</label>
                  <div className="flex flex-wrap gap-2">
                    {establecimientos
                      .filter((e) => String(e.id) !== form.establecimientoId)
                      .map((est) => {
                        const active = form.otrosEstablecimientos.includes(est.id);
                        return (
                          <button
                            key={est.id}
                            type="button"
                            onClick={() => toggleOtroEst(est.id)}
                            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                              active
                                ? 'bg-primary-600 text-white border-primary-600'
                                : 'bg-white text-gray-600 border-gray-300 hover:border-primary-400'
                            }`}
                          >
                            {est.nombre}
                          </button>
                        );
                      })}
                  </div>
                  {form.otrosEstablecimientos.length > 0 && (
                    <p className="text-xs text-gray-400 mt-1">{t('emp_flexible_auto')}</p>
                  )}
                </div>
              )}

              {/* Fixed weekly availability grid — untick slots the worker can NEVER do */}
              <div className="pt-2 border-t border-gray-100">
                <label className="block text-xs font-semibold text-gray-700 mb-1">{t('emp_availability')}</label>
                <p className="text-[11px] text-gray-400 mb-2">{t('emp_availability_hint')}</p>
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="text-gray-500">
                        <th className="text-left font-medium py-1 pr-2"></th>
                        {DIAS_GRID.map((d) => (
                          <th key={d} className="font-medium px-1 text-center">{t('day_' + { LUNES: 'mon', MARTES: 'tue', MIERCOLES: 'wed', JUEVES: 'thu', VIERNES: 'fri', SABADO: 'sat', DOMINGO: 'sun' }[d]).slice(0, 3)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {['M', 'T'].map((slot) => (
                        <tr key={slot}>
                          <td className="py-1 pr-2 text-gray-600 font-medium">{slot === 'M' ? t('shift_morning') : t('shift_afternoon')}</td>
                          {DIAS_GRID.map((d) => {
                            const on = form.disponibilidad[d][slot];
                            return (
                              <td key={d} className="px-1 text-center">
                                <button
                                  type="button"
                                  onClick={() => toggleAvail(d, slot)}
                                  title={on ? t('emp_avail_can') : t('emp_avail_cannot')}
                                  className={`w-7 h-7 rounded-md text-sm font-bold transition-colors ${
                                    on ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-100 text-red-500 hover:bg-red-200'
                                  }`}
                                >
                                  {on ? '✓' : '✕'}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Fixed recurring conditions (free text, read by the AI every week) */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">{t('emp_fixed_conditions')}</label>
                <textarea
                  value={form.condicionesFijas}
                  // Canviar el text descarta la traducció acceptada. Si no,
                  // s'hi desaria una frase nova amb una traducció vella que ja
                  // no diu el mateix — i el motor fa complir la traducció, o
                  // sigui que s'aplicaria una condició diferent de la que hi ha
                  // escrita a la fitxa. La traducció és una conseqüència de la
                  // frase, no una cosa que hi visqui al costat.
                  onChange={(e) => {
                    setForm({ ...form, condicionesFijas: e.target.value, condicionesEstructuradas: null });
                    setTraduccio(null);
                  }}
                  rows={2}
                  placeholder={t('emp_fixed_conditions_ph')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />

                {/* Què n'entén el sistema. Es demana a mà i no en escriure:
                    cada comprovació és una crida a la IA, i traduir a cada
                    tecla costaria diners i no serviria de res fins que la frase
                    no està acabada. */}
                {editing && form.condicionesFijas.trim() && (
                  <div className="mt-2">
                    {!form.condicionesEstructuradas && !traduccio && (
                      <p className="text-[11px] text-amber-700 mb-1">{t('cond_pending')}</p>
                    )}
                    <button type="button" onClick={comprovaCondicions} disabled={traduint}
                      className="text-xs text-primary-700 hover:text-primary-800 underline disabled:opacity-50">
                      {traduint ? t('cond_checking') : t('cond_check')}
                    </button>

                    {traduccio && !traduccio.ok && (
                      <p className="mt-2 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
                        {t('cond_failed')} {(traduccio.errors || []).join(' · ')}
                      </p>
                    )}

                    {traduccio?.ok && (
                      <div className="mt-2 border border-gray-200 rounded-lg p-3 space-y-2">
                        <p className="text-[11px] text-gray-500">{t('cond_understood')}</p>
                        <ul className="space-y-1">
                          {(traduccio.frases || []).map((f) => (
                            <li key={f} className="text-xs text-gray-700 flex gap-1.5">
                              {/* Tres estats i no dos: el que el codi garanteix,
                                  el que només s'intenta, i el que no fa complir
                                  ningú. Amb un sol ✓ verd per a tot, una
                                  preferència es llegia com una garantia. */}
                              <span className={
                                f.startsWith('(NO garantit)') ? 'text-amber-600'
                                  : f.startsWith('(preferència)') ? 'text-sky-600'
                                    : f.startsWith('(') ? 'text-gray-400' : 'text-green-600'
                              }>
                                {f.startsWith('(') ? '•' : '✓'}
                              </span>
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                        {(traduccio.encaraNo || []).length > 0 && (
                          <p className="text-[11px] text-amber-700">{t('cond_not_yet')} {traduccio.encaraNo.join(', ')}</p>
                        )}
                        <p className="text-[11px] text-gray-400">{t('cond_hint')}</p>
                        <button type="button"
                          onClick={() => { setForm({ ...form, condicionesEstructuradas: traduccio.condicions }); setTraduccio(null); }}
                          className="text-xs bg-primary-600 hover:bg-primary-700 text-white rounded-lg px-3 py-1.5">
                          {t('cond_accept')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">{t('cancel')}</button>
                <button type="submit" className="px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors">{t('save')}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
