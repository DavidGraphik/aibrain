import { prisma } from '../services/prisma.js';
import { ajustos } from '../utils/ajustos.js';
import { properaFinestra, quiRepLaPeticio } from '../services/whatsapp.js';
import { readWhatsappConfiguration } from '../controllers/whatsapp.js';
import { zonaHoraria } from '../utils/zonaHoraria.js';

// Configuration evidence only. Provider acceptance and a real reply need their own receipts.
export function createReadinessHandler({ database = prisma, readSettings = ajustos, readConfiguration = readWhatsappConfiguration, now = () => new Date() } = {}) {
  return async (req, res) => {
    const raw = req.query.establecimiento;
    const id = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'Cal indicar una botiga concreta.' });
    const shop = await database.establishment.findUnique({ where: { id }, select: {
      id: true, nombre: true, activo: true,
      managerLocal: { select: { id: true, nombre: true, apellidos: true, activo: true, telefonoWhatsapp: true } },
    } });
    if (!shop) return res.status(404).json({ error: 'Botiga no trobada.' });
    const eligible = quiRepLaPeticio(id);
    delete eligible.telefonoWhatsapp; // Include missing contacts so they cannot silently disappear.
    const [employees, settings, config] = await Promise.all([
      database.employee.findMany({ where: eligible, select: { id: true, nombre: true, apellidos: true, telefonoWhatsapp: true } }),
      readSettings(id), readConfiguration(),
    ]);
    const identity = employee => ({ id: employee.id, name: [employee.nombre, employee.apellidos].filter(Boolean).join(' ').trim() });
    const hasPhone = employee => !!employee?.telefonoWhatsapp?.trim();
    const missing = employees.filter(e => !hasPhone(e)).map(identity);
    const base = [];
    if (!shop.activo) base.push('SHOP_INACTIVE');
    if (!config.deliveryEnabled) base.push('DELIVERY_DISABLED');
    if (config.proveidor !== 'meta' || !config.providerApprovalVerified) base.push('PROVIDER_NOT_VERIFIED');
    if (!config.credencials.WHATSAPP_TOKEN || !config.credencials.WHATSAPP_PHONE_NUMBER_ID) base.push('PROVIDER_CREDENTIALS_MISSING');
    const templateBlockers = key => {
      const template = config.plantilles[key];
      return template?.posada && template.providerStatus === 'APPROVED' && template.fieldsMatch === true ? [] : [`${key}_NOT_READY`];
    };
    const collection = [...base, ...templateBlockers('WHATSAPP_TEMPLATE_BROADCAST'), ...templateBlockers('WHATSAPP_TEMPLATE_REMINDER')];
    if (!config.credencials.META_APP_SECRET) collection.push('INBOUND_SIGNATURE_NOT_CONFIGURED');
    if (!employees.length) collection.push('NO_ACTIVE_EMPLOYEES');
    if (missing.length) collection.push('EMPLOYEE_PHONES_MISSING');
    const automatic = [...collection];
    if (!config.automaticEnabled) automatic.push('AUTOMATIC_DISABLED');
    if (!settings.enviamentAutomatic) automatic.push('SHOP_AUTOMATIC_DISABLED');
    const pdf = [...base, ...templateBlockers('WHATSAPP_TEMPLATE_HORARIO')];
    if (!shop.managerLocal) pdf.push('MANAGER_NOT_ASSIGNED');
    else {
      if (!shop.managerLocal.activo) pdf.push('MANAGER_INACTIVE');
      if (!hasPhone(shop.managerLocal)) pdf.push('MANAGER_PHONE_MISSING');
    }
    const stage = blockers => ({ configurationReady: blockers.length === 0, blockers });
    const window = properaFinestra(now(), {
      obreDia: settings.whatsappObreDia, obreHora: settings.whatsappObreHora,
      tancaDia: settings.whatsappTancaDia, tancaHora: settings.whatsappTancaHora,
    });
    return res.json({
      establishment: { id, name: shop.nombre, active: shop.activo },
      employees: { active: employees.length, withPhone: employees.length - missing.length, missingPhone: missing },
      manager: shop.managerLocal ? { ...identity(shop.managerLocal), active: shop.managerLocal.activo, hasPhone: hasPhone(shop.managerLocal) } : null,
      collection: stage(collection), automaticCollection: stage(automatic), pdfDelivery: stage(pdf),
      collectionWindow: window ? { week: window.semana, opensAt: window.obre.toISOString(), closesAt: window.tanca.toISOString(), timeZone: zonaHoraria() } : null,
      templates: config.plantilles,
      acceptance: { outboundReceipt: 'not_checked', inboundReply: 'not_checked', reviewedExcelRedistribution: 'requires_reviewed_workbook' },
    });
  };
}
