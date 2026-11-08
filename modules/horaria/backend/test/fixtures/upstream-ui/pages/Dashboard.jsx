import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { shiftHours } from '../utils/shiftHours.js';

import client, { getCached, buidaCache } from '../api/client.js';
import ShiftCell from '../components/ShiftCell.jsx';
import PerQueHoVasCanviar, { pendentsDExplicar } from '../components/PerQueHoVasCanviar.jsx';
import BarraAvisos from '../components/BarraAvisos.jsx';
import HistorialCanvis from '../components/HistorialCanvis.jsx';
import { ambNomsHumans, etiquetaTorn } from '../utils/etiquetes.js';
import { peticioDeLaCasella, compleixLaPeticio } from '../utils/peticions.js';
import { agrupaAvisos, avisosDeLEquip } from '../utils/avisos.js';
import { ordenaEquip, inicisDeGrup } from '../utils/ordreEquip.js';
import ShiftEditModal from '../components/ShiftEditModal.jsx';
import RulesForm from '../components/RulesForm.jsx';
import AIGenerateModal from '../components/AIGenerateModal.jsx';
import AIResultPanel from '../components/AIResultPanel.jsx';
import FairnessPanel, { hiHaEquitat } from '../components/FairnessPanel.jsx';
import { useLanguage } from '../context/LanguageContext.jsx';
import { weekLabelLocalized, getISOWeek } from '../utils/weekLabel.js';

const DIAS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];


export default function Dashboard() {
  const { t, lang, getMonths, getDays } = useLanguage();
  const MESES = getMonths();
  const DIAS_LABEL = getDays();

  // Remember the week/establishment the manager was working on, so switching
  // to another tab and back doesn't reset to "today / first establishment".
  const [semana, setSemana] = useState(
    () => sessionStorage.getItem('shiftai_semana') || getISOWeek(new Date())
  );
  const [establecimientoId, setEstablecimientoId] = useState(() => sessionStorage.getItem('shiftai_est') || '');
  const [establecimientos, setEstablecimientos] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [preferences, setPreferences] = useState([]);
  const [estConflicts, setEstConflicts] = useState([]);
  const [condSinComprobar, setCondSinComprobar] = useState([]);
  const [condPerPeticio, setCondPerPeticio] = useState([]);
  const [personalMessages, setPersonalMessages] = useState([]);
  const [altSabados, setAltSabados] = useState([]);
  const [correccions, setCorreccions] = useState([]);
  const [historial, setHistorial] = useState([]);
  const [equitat, setEquitat] = useState({ scores: [], patterns: [] });
  // Photographed preference sheets for this week, so a reading can be checked
  // against the paper it came from.
  const [paperSheets, setPaperSheets] = useState([]);
  const [sheetUrl, setSheetUrl] = useState(null);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [pujantFull, setPujantFull] = useState(false);
  const inputFull = useRef(null);
  // La càrrega de la setmana viu dins d'un useEffect sense nom; pujar un full
  // canvia les preferències i cal tornar-la a fer sense canviar ni de setmana
  // ni de botiga. Aquest comptador és l'única manera de demanar-l'hi.
  const [recarrega, setRecarrega] = useState(0);
  const [otherHours, setOtherHours] = useState({});
  const [loading, setLoading] = useState(false);
  const [editingCell, setEditingCell] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const [intensidad, setIntensidad] = useState(100);
  const [cerradosSemana, setCerradosSemana] = useState([]);
  const [savingIntensidad, setSavingIntensidad] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [generantPDF, setGenerantPDF] = useState(false);
  const [showAIModal, setShowAIModal] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiResult, setAiResult] = useState(null);

  const wLabel = weekLabelLocalized(semana, MESES);

  useEffect(() => {
    getCached('/establishments').then(({ data }) => {
      setEstablecimientos(data);
      if (data.length === 0) return;
      // Keep the remembered establishment if it still exists, else fall back
      const remembered = sessionStorage.getItem('shiftai_est');
      const stillExists = remembered && data.some((e) => String(e.id) === remembered);
      setEstablecimientoId(stillExists ? remembered : String(data[0].id));
    });
  }, []);

  // Persist the current view so it survives navigating away and back
  useEffect(() => {
    if (semana) sessionStorage.setItem('shiftai_semana', semana);
  }, [semana]);
  useEffect(() => {
    if (establecimientoId) sessionStorage.setItem('shiftai_est', establecimientoId);
  }, [establecimientoId]);

  /**
   * Tot el que canvia quan es toca la setmana: conflictes, correccions per
   * explicar i equitat.
   *
   * Viu en una funció perquè la llista estava escrita a mà als tres llocs que
   * la refresquen — la càrrega inicial, desar una casella i generar — i dues
   * vegades seguides se n'hi va quedar una fora. Primer la marca de peticions,
   * després el panell de correccions i la pastilla d'equitat: la pantalla
   * ensenyava el que era veritat en obrir-la, no el que ho és ara.
   *
   * Les crides van per la memòria cau, o sigui que cridar-la de seguida
   * després de la càrrega inicial no és una volta més a la xarxa.
   */
  // Quina setmana i botiga van demanar l'última refrescada. Sense això, canviar
  // de setmana dues vegades de pressa deixa la resposta lenta de la primera
  // arribant després de la segona i trepitjant-la: la barra ensenyaria els
  // avisos d'una setmana que ja no estàs mirant.
  const peticioVigent = useRef('');

  async function refrescaAvisos() {
    if (!establecimientoId || !semana) return;
    const clau = `${semana}|${establecimientoId}`;
    peticioVigent.current = clau;
    const [c, corr, fair, pats, hist] = await Promise.all([
      getCached(`/schedules/conflicts?semana=${semana}&establecimiento=${establecimientoId}&lang=${lang}`).catch(() => ({ data: {} })),
      getCached(`/schedules/correcciones?semana=${semana}&establecimiento=${establecimientoId}`).catch(() => ({ data: {} })),
      getCached(`/schedules/fairness?semana=${semana}&establecimiento=${establecimientoId}`).catch(() => ({ data: [] })),
      getCached(`/schedules/edit-patterns?establecimiento=${establecimientoId}`).catch(() => ({ data: [] })),
      getCached(`/schedules/historial?semana=${semana}&establecimiento=${establecimientoId}`).catch(() => ({ data: [] })),
    ]);
    // Mentre esperàvem, algú ha canviat de setmana o de botiga: aquests avisos
    // ja no són d'on som.
    if (peticioVigent.current !== clau) return;

    setEstConflicts(c.data.conflictos || []);
    setCondSinComprobar(c.data.condicionesSinComprobar || []);
    setCondPerPeticio(c.data.perPeticio || []);
    setPersonalMessages(c.data.personals || []);
    setAltSabados(c.data.alternanca || []);
    setCorreccions(corr.data?.correcciones || []);
    setEquitat({ scores: fair.data || [], patterns: pats.data || [] });
    setHistorial(hist.data || []);
  }

  useEffect(() => {
    if (!establecimientoId || !semana) return;
    setLoading(true);
    // Els avisos van a la seva pròpia cadena perquè refrescaAvisos() és també
    // la que fan servir desar i generar, però s'espera igual abans de treure el
    // «carregant»: si no, la taula es dibuixava i la barra d'avisos apareixia
    // un instant després, amb els de la setmana anterior encara posats.
    const avisos = refrescaAvisos();
    const base = Promise.all([
      getCached(`/schedules?semana=${semana}&establecimiento=${establecimientoId}`),
      getCached(`/employees?establecimiento=${establecimientoId}`),
      getCached(`/preferences?semana=${semana}&establecimiento=${establecimientoId}`),
      getCached(`/schedules/other-hours?semana=${semana}&establecimiento=${establecimientoId}`),
      getCached(`/schedules/report?semana=${semana}&establecimiento=${establecimientoId}`).catch(() => ({ data: { informe: null } })),
      getCached(`/schedules/intensity?semana=${semana}&establecimiento=${establecimientoId}`).catch(() => ({ data: { porcentaje: 100 } })),
      getCached(`/schedules/closed-days?semana=${semana}&establecimiento=${establecimientoId}`).catch(() => ({ data: { dias: [] } })),
      getCached(`/preferences/sheets?semana=${semana}&establecimiento=${establecimientoId}`).catch(() => ({ data: [] })),
    ])
      .then(([s, e, p, o, r, inten, closed, sheets]) => {
        setSchedules(s.data);
        setEmployees(ordenaEquip(e.data));
        setPreferences(p.data);
        setOtherHours(o.data || {});
        setIntensidad(inten.data?.porcentaje ?? 100);
        setCerradosSemana(closed.data?.dias || []);
        setPaperSheets(sheets.data || []);
        // Stored generation report → so the manager sees it when opening the week later
        setAiResult(r.data.informe
          ? { resumen: r.data.informe.resumen, conflictos: r.data.informe.conflictos, informeCanvis: r.data.informe.informeCanvis }
          : null);
      });
    Promise.all([base, avisos]).finally(() => setLoading(false));
  }, [semana, establecimientoId, recarrega]);

  // Build lookup maps
  const scheduleMap = useMemo(() => {
    const m = {};
    for (const s of schedules) {
      if (!m[s.empleadoId]) m[s.empleadoId] = {};
      m[s.empleadoId][s.dia] = s;
    }
    return m;
  }, [schedules]);

  // Un avís per persona i no per casella: vegeu utils/avisos.js.
  //
  // Va DARRERE de scheduleMap i no davant. Posat abans, la llista de
  // dependències el llegia abans que existís i cada render petava amb un
  // ReferenceError: la pantalla sencera en blanc, i des de fora semblava que el
  // desplegament no hagués arribat.
  const avisosAgrupats = useMemo(() => {
    const per = {};
    for (const emp of employees) per[emp.id] = agrupaAvisos(Object.values(scheduleMap[emp.id] || {}));
    return per;
  }, [employees, scheduleMap]);
  // Els mateixos dos blocs que al full imprès: la gent de la botiga i la de
  // l'obrador es miren l'horari per separat.
  const titolsDeGrup = useMemo(() => inicisDeGrup(employees), [employees]);
  const resumAvisos = useMemo(() => avisosDeLEquip(employees, scheduleMap), [employees, scheduleMap]);
  const prefMap = {};
  for (const p of preferences) prefMap[p.empleadoId] = p;

  // Stats
  const totalEmployees = employees.length;
  const withPreferences = preferences.length;
  const published = schedules.length > 0 && schedules.every((s) => s.publicado);

  // Which shop is on screen. It used to be declared inside the hours block that
  // moved to the server, and went with it — taking the printed sheet, the grid's
  // leaving times and the whole page down with it.
  const establecimientoActual = establecimientos.find((e) => String(e.id) === String(establecimientoId));

  // The hours and the fixed conditions are worked out on the server now, in a
  // single pass, and this screen displays the answer. It used to compute the
  // hours here against its own idea of the week's target while the server used
  // the bare contract — two figures for one question, which is the shape of the
  // bug that once cost Nuria Bachs her day off.
  const totalConflicts = personalMessages.length + estConflicts.length;

  function dayTotals(dia) {
    const depM = employees.filter((e) => {
      const s = scheduleMap[e.id]?.[dia];
      return e.funcion === 'DEPENDIENTA' && s && (s.turno === 'MANANA' || s.turno === 'PARTIDO');
    }).length;
    const depT = employees.filter((e) => {
      const s = scheduleMap[e.id]?.[dia];
      return e.funcion === 'DEPENDIENTA' && s && (s.turno === 'TARDE' || s.turno === 'PARTIDO');
    }).length;
    const elaM = employees.filter((e) => {
      const s = scheduleMap[e.id]?.[dia];
      return e.funcion === 'ELABORACION' && s && (s.turno === 'MANANA' || s.turno === 'PARTIDO');
    }).length;
    const elaT = employees.filter((e) => {
      const s = scheduleMap[e.id]?.[dia];
      return e.funcion === 'ELABORACION' && s && (s.turno === 'TARDE' || s.turno === 'PARTIDO');
    }).length;
    return { depM, depT, elaM, elaT };
  }

  function shiftWeekHours(empId) {
    const emp = employees.find((e) => e.id === empId);
    return Object.values(scheduleMap[empId] || {}).reduce(
      (sum, s) => sum + shiftHours(emp, s.turno), 0
    );
  }

  function prevWeek() {
    const [year, week] = semana.split('-W');
    const d = new Date(parseInt(year), 0, 4);
    d.setDate(d.getDate() + (parseInt(week) - 1) * 7 - 7);
    setSemana(getISOWeek(d));
  }
  function nextWeek() {
    const [year, week] = semana.split('-W');
    const d = new Date(parseInt(year), 0, 4);
    d.setDate(d.getDate() + (parseInt(week) - 1) * 7 + 7);
    setSemana(getISOWeek(d));
  }

  // Days the establishment is closed this week (weekly closure + festivos).
  // Derived from the schedule itself: a day where absolutely everyone is LIBRE
  // and the establishment declares it closed. We ask the API for accuracy.
  const closedDays = new Set(cerradosSemana);

  function openEdit(employee, dia) {
    if (closedDays.has(dia)) return; // closed → not editable
    setEditingCell({ employee, dia, shift: scheduleMap[employee.id]?.[dia] || null });
  }

  // La llibreria del PDF són 367 KB —jsPDF, autoTable, html2canvas i purify—
  // i només fa falta quan es clica «descarregar» o es publica. Importada a
  // dalt, es baixava sempre: també quan només entres des del mòbil de la
  // botiga a mirar l'horari.
  //
  // Amb un import dins d'una funció, Vite la separa en un fitxer a part i el
  // navegador només la demana el dia que la fas servir.
  async function generaPDF(opcions) {
    const { generateSchedulePDF } = await import('../utils/generatePDF.js');
    return generateSchedulePDF(opcions);
  }

  async function handleSaveShift({ turno, horaEntrada, horaDescanso }) {
    const { employee, dia, shift } = editingCell;

    // Desfer una petició ha de costar un clic més. No es bloqueja: de vegades
    // la cobertura obliga, i deixar-la sense sortida seria pitjor que
    // l'oblit que això evita.
    //
    // Només els dies de festa demanats. Un dia de festa és «aquell dia no puc
    // venir», i trencar-ho vol dir que la persona no es presenta; un torn
    // demanat és una preferència, i la responsable en gira uns quants cada
    // setmana per quadrar la cobertura. Avisar també d'aquells convertiria la
    // confirmació en un tràmit que s'accepta sense llegir, i llavors ja no
    // protegiria el cas que sí importa.
    //
    // Es mira si el torn NOU segueix complint la petició, no si és diferent.
    // `compleixLaPeticio` i no `!== null`: des que la marca també surt quan la
    // petició NO es compleix, un «no és null» voldria dir que segueix complint
    // sempre, i la confirmació no saltaria mai.
    const seguiraComplint = compleixLaPeticio(
      peticioDeLaCasella({ dia, turno, prefs: prefMap[employee.id] }));
    if (shift?.peticio === 'NO_DISPONIBLE' && !seguiraComplint) {
      const qui = `${employee.nombre} ${employee.apellidos}`;
      if (!window.confirm(t('shift_req_warn_off').replace('{qui}', qui))) return;
    }

    if (shift) {
      const { data } = await client.put(`/schedules/${shift.id}`, { turno, horaEntrada, horaDescanso });
      setSchedules((prev) => prev.map((s) => s.id === shift.id ? { ...s, ...data } : s));
    } else {
      const { data } = await client.post('/schedules', {
        empleadoId: employee.id,
        establecimientoId: parseInt(establecimientoId),
        semana,
        dia,
        turno,
        horaEntrada,
        horaDescanso,
      });
      setSchedules((prev) => [...prev, data]);
    }
    refrescaAvisos();
    setEditingCell(null);
  }

  async function handleIntensidad(pct) {
    setIntensidad(pct);
    setSavingIntensidad(true);
    try {
      await client.post('/schedules/intensity', {
        semana,
        establecimientoId: parseInt(establecimientoId),
        porcentaje: pct,
      });
    } catch (err) {
      alert(err.response?.data?.error || t('error_saving'));
    } finally {
      setSavingIntensidad(false);
    }
  }

  async function handleGenerate(quality = 'standard') {
    setGenerating(true);
    try {
      // Start the generation as a background job (returns immediately) and poll
      // its status — the AI takes 1-3 minutes, longer than browser/proxy timeouts.
      const { data: started } = await client.post('/schedules/generate-async', {
        establecimientoId: parseInt(establecimientoId),
        semana,
        quality,
      });

      const POLL_MS = 4000;
      const MAX_POLLS = 150; // ~10 minutes safety cap
      let status;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const { data } = await client.get(`/schedules/generate-status/${started.jobId}`);
        status = data;
        if (data.status !== 'running') break;
      }

      if (!status || status.status === 'running') {
        throw new Error(t('dash_error_generate_timeout'));
      }
      if (status.status === 'error') {
        throw new Error(status.error || t('dash_error_generate'));
      }

      // Done — reload the saved schedules and conflicts
      const { data: scheds } = await client.get(`/schedules?semana=${semana}&establecimiento=${establecimientoId}`);
      setSchedules(scheds);
      setAiResult({ resumen: status.resumen, conflictos: status.conflictos, informeCanvis: status.informeCanvis });
      await refrescaAvisos();
    } catch (err) {
      alert(err.response?.data?.error || err.message || t('dash_error_generate'));
    } finally {
      setGenerating(false);
      setShowAIModal(false);
    }
  }

  // The image needs the same token as everything else, so it cannot simply be
  // an <img src>. Fetch it, hold it as a blob URL, and hand it back when the
  // viewer closes — an object URL that is never revoked keeps the whole photo
  // in memory for as long as the tab is open.
  async function verFullOriginal(id) {
    setSheetLoading(true);
    try {
      const { data } = await client.get(`/preferences/sheets/${id}/image`, { responseType: 'blob' });
      setSheetUrl(URL.createObjectURL(data));
    } catch {
      alert(t('sheet_error'));
    } finally {
      setSheetLoading(false);
    }
  }

  // Pujar el full de paper que han omplert a la botiga. Fins ara l'única manera
  // de ficar-lo a l'app era fotografiar-lo i enviar-lo al WhatsApp del bot,
  // encara que el tinguessis a la mà davant de l'ordinador.
  async function pujarFull(e) {
    const fitxer = e.target.files?.[0];
    // Es buida sempre: sense això, tornar a triar el mateix fitxer després
    // d'un error no dispara cap canvi i el botó sembla espatllat.
    e.target.value = '';
    if (!fitxer) return;

    setPujantFull(true);
    try {
      const fd = new FormData();
      fd.append('imagen', fitxer);
      const { data } = await client.post('/preferences/sheets', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      // El resum diu què ha llegit de cada persona i qui no ha reconegut. És
      // el que deixa comprovar la lectura, que és on la IA s'equivoca en
      // silenci: una marca llegida una columna més enllà surt igual de neta.
      alert(data.resumen);
      buidaCache();
      setRecarrega((n) => n + 1);
    } catch (err) {
      alert(err.response?.data?.error || t('sheet_upload_error'));
    } finally {
      setPujantFull(false);
    }
  }

  function tancarFull() {
    if (sheetUrl) URL.revokeObjectURL(sheetUrl);
    setSheetUrl(null);
  }

  async function handlePublish() {
    if (!window.confirm(t('dash_confirm_publish'))) return;
    setPublishing(true);
    try {
      // Attach the same PDF the manager downloads, so the encargado gets the file
      const pdfBlob = await generaPDF({
        establecimiento: establecimientoActual?.nombre || '',
        establishment: establecimientoActual,
        semana,
        employees,
        schedules,
        returnBlob: true,
      });
      const fd = new FormData();
      fd.append('semana', semana);
      fd.append('establecimientoId', String(parseInt(establecimientoId)));
      if (pdfBlob) fd.append('pdf', pdfBlob, `horario_${semana}.pdf`);
      const { data } = await client.post('/schedules/publish', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setSchedules((prev) => prev.map((s) => ({ ...s, publicado: true })));
      // The generic "could not send" cost a day: it looked the same whether
      // the number was wrong or WhatsApp had refused for a documented reason.
      // When Meta says why, say why.
      alert(data.notificado
        ? `${t('dash_published_ok')} ${t('dash_sent_to')} ${data.notificado}.`
        : data.avisoEnvio === 'sin_telefono'
          ? `${t('dash_published_ok')} ${t('dash_no_manager_phone')}`
          : [t('dash_published_ok'), t('dash_send_failed'), data.detalleEnvio].filter(Boolean).join('\n\n'));
    } catch (err) {
      alert(err.response?.data?.error || t('error_saving'));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{t('dash_title')}</h2>
          <p className="text-sm text-gray-500">{wLabel}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={establecimientoId}
            onChange={(e) => setEstablecimientoId(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {establecimientos.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}
          </select>
          <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
            <button onClick={prevWeek} className="px-3 py-2 text-sm hover:bg-gray-50">&larr;</button>
            <span className="px-3 py-2 text-sm font-medium border-x border-gray-300">{wLabel}</span>
            <button onClick={nextWeek} className="px-3 py-2 text-sm hover:bg-gray-50">&rarr;</button>
          </div>
          <div className="flex items-center gap-1.5 border border-gray-300 rounded-lg px-2 py-1" title={t('dash_intensity_hint')}>
            <span className="text-xs text-gray-500">{t('dash_intensity')}</span>
            <select
              value={intensidad}
              onChange={(e) => handleIntensidad(parseInt(e.target.value))}
              disabled={savingIntensidad}
              className="text-sm bg-transparent focus:outline-none disabled:opacity-50"
            >
              <option value={70}>70% · {t('dash_intensity_low')}</option>
              <option value={85}>85%</option>
              <option value={100}>100% · {t('dash_intensity_normal')}</option>
              <option value={110}>110%</option>
              <option value={120}>120% · {t('dash_intensity_high')}</option>
            </select>
          </div>
          <button
            onClick={() => setShowRules(true)}
            className="border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {t('dash_rules')}
          </button>
          <input
            ref={inputFull}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={pujarFull}
          />
          <button
            onClick={() => inputFull.current?.click()}
            disabled={pujantFull}
            title={t('sheet_upload_hint')}
            className="border border-gray-300 hover:bg-gray-50 disabled:opacity-40 text-gray-700 text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {pujantFull ? t('sheet_uploading') : t('sheet_upload')}
          </button>
          {paperSheets.length > 0 && (
            <button
              onClick={() => verFullOriginal(paperSheets[0].id)}
              disabled={sheetLoading}
              title={t('sheet_button_hint')}
              className="border border-gray-300 hover:bg-gray-50 disabled:opacity-40 text-gray-700 text-sm px-4 py-2 rounded-lg transition-colors"
            >
              {sheetLoading ? t('sheet_loading') : t('sheet_button')}
            </button>
          )}
          <button
            onClick={() => setShowAIModal(true)}
            disabled={employees.length === 0}
            className="border border-primary-300 bg-primary-50 hover:bg-primary-100 disabled:opacity-40 text-primary-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            ✨ {t('dash_generate_ai')}
          </button>
          {/* La primera vegada, aquest botó ha de baixar els 425 KB de la
              llibreria abans de fer res. Sense avisar-ho, amb la connexió de la
              botiga sembla que el clic no ha fet res i s'acaba clicant tres
              cops; i si la baixada falla, no se n'assabenta ningú. */}
          <button
            onClick={async () => {
              setGenerantPDF(true);
              try {
                await generaPDF({
                  establecimiento: establecimientoActual?.nombre || 'Establecimiento',
                  establishment: establecimientoActual,
                  semana,
                  employees,
                  schedules,
                });
              } catch (err) {
                alert(err?.message || t('dash_error_pdf'));
              } finally {
                setGenerantPDF(false);
              }
            }}
            disabled={employees.length === 0 || generantPDF}
            className="border border-gray-300 hover:bg-gray-50 disabled:opacity-40 text-gray-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {generantPDF ? t('dash_preparing_pdf') : t('dash_download_pdf')}
          </button>
          <button
            onClick={handlePublish}
            disabled={publishing || published}
            className="bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {published ? `✓ ${t('dash_published')}` : publishing ? t('dash_publishing') : t('dash_publish')}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
        {[
          { label: t('dash_employees'), value: totalEmployees },
          { label: t('dash_preferences'), value: `${withPreferences}/${totalEmployees}` },
          { label: t('dash_conflicts'), value: totalConflicts, alert: totalConflicts > 0 },
          { label: t('dash_status'), value: published ? t('dash_published') : t('dash_draft'), ok: published },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 px-5 py-4">
            <p className="text-xs text-gray-500">{s.label}</p>
            <p className={`text-xl sm:text-2xl font-semibold mt-0.5 sm:mt-1 ${s.alert ? 'text-red-600' : s.ok ? 'text-green-600' : 'text-gray-900'}`}>
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {/* One bar instead of five stacked panels — see BarraAvisos. Ordered by
          how much each one matters: something is wrong, something needs you,
          something you should know. */}
      <BarraAvisos
        seccions={[
          (estConflicts.length > 0 || personalMessages.length > 0 || altSabados.length > 0) && {
            id: 'conflictes',
            to: 'vermell',
            etiqueta: t('pill_conflicts'),
            recompte: personalMessages.length + estConflicts.length + altSabados.length,
            contingut: (
              <div className="space-y-3">
                {personalMessages.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-red-600 mb-1">{t('dash_employees_section')}</p>
                    <ul className="space-y-0.5">
                      {personalMessages.map((c, i) => <li key={i} className="text-xs text-red-600">• {c}</li>)}
                    </ul>
                  </div>
                )}
                {altSabados.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-red-600 mb-1">{t('dash_saturday_rotation')}</p>
                    <ul className="space-y-0.5">
                      {altSabados.map((c, i) => <li key={i} className="text-xs text-red-600">• {c}</li>)}
                    </ul>
                  </div>
                )}
                {estConflicts.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-red-600 mb-1">{t('dash_min_coverage')}</p>
                    <ul className="space-y-0.5">
                      {estConflicts.map((c, i) => <li key={i} className="text-xs text-red-600">• {c}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            ),
          },
          pendentsDExplicar(correccions) > 0 && {
            id: 'per-que',
            to: 'blau',
            etiqueta: t('pill_why'),
            recompte: pendentsDExplicar(correccions),
            contingut: (
              <PerQueHoVasCanviar
                correccions={correccions}
                semana={semana}
                establecimientoId={establecimientoId}
                onDesat={(clau) => setCorreccions((cs) => cs.map(
                  (c) => (c.clau === clau ? { ...c, explicat: true } : c)
                ))}
              />
            ),
          },
          historial.length > 0 && {
            id: 'historial',
            to: 'gris',
            etiqueta: t('pill_historial'),
            recompte: historial.length,
            contingut: <HistorialCanvis canvis={historial} dies={getDays()} />,
          },
          condPerPeticio.length > 0 && {
            id: 'per-peticio',
            to: 'gris',
            etiqueta: t('pill_requests'),
            recompte: condPerPeticio.reduce((n, c) => n + c.frases.length, 0),
            contingut: (
              <div>
                <p className="text-sm font-semibold text-gray-800 mb-1">{t('requests_title')}</p>
                <p className="text-xs text-gray-500 mb-2">{t('requests_hint')}</p>
                <ul className="space-y-1">
                  {condPerPeticio.map((c) => (
                    <li key={c.nombre} className="text-xs text-gray-700">
                      <span className="font-medium">{c.nombre}</span>
                      <ul className="ml-3">
                        {c.frases.map((f, i) => <li key={i}>· {ambNomsHumans(f, lang)}</li>)}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          },
          condSinComprobar.length > 0 && {
            id: 'sense-comprovar',
            to: 'ambre',
            etiqueta: t('pill_unchecked'),
            recompte: condSinComprobar.length,
            contingut: (
              <div>
                <p className="text-sm font-semibold text-gray-800 mb-1">{t('dash_unchecked_title')}</p>
                <p className="text-xs text-amber-700 mb-2">{t('dash_unchecked_hint')}</p>
                <ul className="space-y-1">
                  {condSinComprobar.map((c) => (
                    <li key={c.nombre} className="text-xs text-amber-800">
                      <span className="font-medium">{c.nombre}</span>
                      <ul className="ml-3">
                        {c.frases.map((f, i) => <li key={i}>· «{ambNomsHumans(f, lang)}»</li>)}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          },
          resumAvisos.length > 0 && {
            id: 'avisos',
            to: 'vermell',
            etiqueta: `${t('pill_alerts')} (${resumAvisos.reduce((n, x) => n + x.avisos.length, 0)})`,
            contingut: (
              <div className="p-4">
                <p className="text-xs text-gray-500 mb-3">{t('alerts_intro')}</p>
                <ul className="flex flex-col gap-2">
                  {resumAvisos.map(({ empleado, avisos }) => (
                    <li key={empleado.id} className="text-sm">
                      <span className="font-medium text-gray-800">{empleado.nombre} {empleado.apellidos}</span>
                      <ul className="mt-0.5 flex flex-col gap-0.5">
                        {avisos.map((a) => (
                          <li key={a.nota} className="text-gray-600 text-xs pl-3 border-l-2 border-red-200">
                            {a.nota}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          },
          aiResult && {
            id: 'informe',
            to: 'gris',
            etiqueta: t('pill_report'),
            contingut: (
              <AIResultPanel
                nu
                resumen={aiResult.resumen}
                conflictos={aiResult.conflictos}
                informeCanvis={aiResult.informeCanvis}
                employees={employees}
                hasRealConflicts={totalConflicts > 0}
                onClose={() => setAiResult(null)}
              />
            ),
          },
          hiHaEquitat(equitat.scores, equitat.patterns) && {
            id: 'equitat',
            to: 'gris',
            etiqueta: t('pill_fairness'),
            contingut: <FairnessPanel nu establecimientoId={establecimientoId} semana={semana} />,
          },
        ]}
      />

      {/* Schedule grid */}
      {loading ? (
        <p className="text-gray-500 text-sm">{t('loading')}</p>
      ) : employees.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <p className="text-gray-400">{t('dash_no_employees')}</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600 w-44">{t('dash_employee')}</th>
                {DIAS.map((d) => (
                  <th key={d} className="text-center px-2 py-3 font-medium text-gray-600 min-w-[90px]">
                    {DIAS_LABEL[d]}
                  </th>
                ))}
                <th className="text-center px-3 py-3 font-medium text-gray-600 w-16">{t('dash_hours')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {employees.map((emp) => {
                const hours = shiftWeekHours(emp.id);
                const otherH = otherHours[emp.id]?.horas || 0;
                const totalHours = hours + otherH;
                const diff = totalHours - emp.maxHorasSemana;
                const tooLow = diff < -2;
                const color = tooLow ? 'text-orange-600' : diff > 0 ? 'text-red-600' : 'text-gray-600';
                const isVisitor = emp.esVisitante;
                return (
                  <Fragment key={emp.id}>
                  {titolsDeGrup[emp.id] && (
                    <tr className="bg-gray-50">
                      <td colSpan={DIAS.length + 2} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        {titolsDeGrup[emp.id] === 'DEPENDIENTA' ? t('func_dependienta') : t('func_elaboracion')}
                      </td>
                    </tr>
                  )}
                  <tr className={`hover:bg-gray-50 group ${isVisitor ? 'bg-amber-50/30' : ''}`}>
                    <td className="px-4 py-2">
                      <p className="font-medium text-gray-800 flex items-center gap-1.5">
                        {emp.nombre} {emp.apellidos}
                        {avisosAgrupats[emp.id]?.dePersona?.length > 0 && (
                          <span
                            title={avisosAgrupats[emp.id].dePersona.map((a) => a.nota).join('\n')}
                            className="text-[10px] font-semibold bg-red-100 text-red-700 px-1.5 py-0.5 rounded cursor-help"
                          >
                            ⚠ {avisosAgrupats[emp.id].dePersona.length}
                          </span>
                        )}
                        {isVisitor && (
                          <span className="text-[9px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded uppercase">
                            {t('dash_visitor')}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-gray-400">
                        {emp.funcion === 'DEPENDIENTA' ? t('func_dependienta') : t('func_elaboracion')}
                        {isVisitor && emp.establecimiento?.nombre && (
                          <span className="text-amber-600"> · {t('dash_from')} {emp.establecimiento.nombre}</span>
                        )}
                      </p>
                    </td>
                    {DIAS.map((dia) => {
                      const occupiedElsewhere = otherHours[emp.id]?.detalles?.find((x) => x.dia === dia);
                      return (
                        <td key={dia} className="px-1 py-2">
                          {occupiedElsewhere ? (
                            <div
                              title={`${occupiedElsewhere.establecimiento} (${etiquetaTorn(occupiedElsewhere.turno, lang)})`}
                              className="text-center text-[10px] bg-amber-100 text-amber-700 rounded py-1.5 px-1 cursor-help"
                            >
                              {occupiedElsewhere.establecimiento.split(' ')[0]}
                            </div>
                          ) : (
                            <ShiftCell
                              shift={scheduleMap[emp.id]?.[dia]}
                              preference={prefMap[emp.id]}
                              avisDePersona={
                                !!scheduleMap[emp.id]?.[dia]?.notaConflicto
                                && !avisosAgrupats[emp.id]?.perDia?.[dia]
                              }
                              empleado={emp}
                              establecimiento={establecimientoActual}
                              closed={closedDays.has(dia)}
                              onClick={() => openEdit(emp, dia)}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td className={`px-3 py-2 text-center text-sm font-medium ${color}`}>
                      {hours}h
                      {otherH > 0 && (
                        <span className="block text-[9px] text-amber-600">+{otherH}h {t('dash_others')}</span>
                      )}
                      <span className="block text-[10px] text-gray-400">/{emp.maxHorasSemana}h</span>
                    </td>
                  </tr>
                  </Fragment>
                );
              })}

              {/* Totals per day */}
              <tr className="bg-gray-50 border-t-2 border-gray-200">
                <td className="px-4 py-2 text-xs font-semibold text-gray-500">{t('dash_total_shift')}</td>
                {DIAS.map((dia) => {
                  const { depM, depT, elaM, elaT } = dayTotals(dia);
                  return (
                    <td key={dia} className="px-1 py-2 text-center">
                      <div className="text-[10px] text-gray-500 space-y-0.5">
                        <div className="bg-blue-50 rounded px-1 py-0.5">D: {depM}M {depT}T</div>
                        <div className="bg-green-50 rounded px-1 py-0.5">E: {elaM}M {elaT}T</div>
                      </div>
                    </td>
                  );
                })}
                <td></td>
              </tr>
            </tbody>
          </table>

          {/* Legend */}
          <div className="flex items-center gap-4 px-4 py-3 border-t border-gray-100 text-xs text-gray-400">
            <span className="font-medium text-gray-500">{t('dash_legend')}</span>
            <span><strong>M</strong> {t('dash_morning')}</span>
            <span><strong>T</strong> {t('dash_afternoon')}</span>
            <span><strong>D</strong> {t('dash_full_day')}</span>
            <span><strong>F</strong> {t('dash_free')}</span>
            <span>⚠ {t('dash_conflict')}</span>
            <span className="ml-auto"><strong>D:</strong> {t('dash_dependientas')} · <strong>E:</strong> {t('dash_elaboracion')}</span>
          </div>
        </div>
      )}

      {/* Modals */}
      {editingCell && (
        <ShiftEditModal
          employee={editingCell.employee}
          dia={editingCell.dia}
          shift={editingCell.shift}
          preference={prefMap[editingCell.employee.id]}
          onSave={handleSaveShift}
          onClose={() => setEditingCell(null)}
        />
      )}
      {showRules && (
        <RulesForm
          establecimientoId={parseInt(establecimientoId)}
          onClose={() => setShowRules(false)}
        />
      )}
      {sheetUrl && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex flex-col items-center justify-center p-4"
          onClick={tancarFull}
        >
          <div className="flex items-center justify-between w-full max-w-4xl mb-3">
            <p className="text-white text-sm">{t('sheet_title')}</p>
            <button
              onClick={tancarFull}
              className="text-white/90 hover:text-white text-sm border border-white/40 rounded-lg px-3 py-1"
            >
              {t('close')}
            </button>
          </div>
          <img
            src={sheetUrl}
            alt={t('sheet_title')}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-full object-contain rounded-lg bg-white"
          />
        </div>
      )}

      {showAIModal && (
        <AIGenerateModal
          generating={generating}
          onGenerate={handleGenerate}
          onClose={() => setShowAIModal(false)}
        />
      )}
    </div>
  );
}
