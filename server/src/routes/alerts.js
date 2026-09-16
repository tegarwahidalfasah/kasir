// ===========================================================================
//  Rute Peringatan (Low Stock Alerts, Fase 3)
// ===========================================================================
import express from 'express';
import { allRows, firstRow, exec, loadSetting } from '../db/index.js';
import { authenticate, requirePerm } from '../middleware/index.js';
import { listAlerts, markAlertRead, generateAlerts, stockHealth } from '../stockhealth.js';
import { DEFAULTS } from '../config.js';
import { audit } from '../auth.js';
import { http } from '../lib/http.js';

export const router = express.Router();
const MOUNT = ''; // path sudah memuat prefiks; mount di index.js memakai '/api'
const auth = (...p) => [authenticate, ...p.map((x) => requirePerm(x))].flat();


router.get(MOUNT + '/alerts', auth(), http((req, res) => {
  const cfg = loadSetting(req.storeId, 'tax', DEFAULTS.tax);
  const items = listAlerts(req.storeId, { limit: Number(req.query.limit) || 80, unreadBy: req.user.id });
  const health = stockHealth({ storeId: req.storeId, days: cfg.consumption_window_days, lookaheadDays: cfg.alert_lookahead_days });
  res.json({
    items,
    unread: items.filter((a) => !a.is_read).length,
    at_risk: health.filter((h) => h.status !== 'ok').length,
    critical: health.filter((h) => h.status === 'critical' || h.status === 'out').length,
    config: { consumption_window_days: cfg.consumption_window_days, alert_lookahead_days: cfg.alert_lookahead_days },
  });
}));

router.post(MOUNT + '/alerts/read/:id', auth(), http((req, res) => {
  const all = req.params.id === 'all';
  const out = markAlertRead(req.storeId, req.user.id, all ? null : req.params.id);
  audit({ userId: req.user.id, role: req.user.role, action: 'alert.dismiss', entity: 'alert', entityId: all ? 'all' : req.params.id, storeId: req.storeId, ip: req.ip, after: { all } });
  res.json({ ok: true, ...(out || {}) });
}));

/** Ringkasan "apa yang harus dibeli" berdasarkan konsumsi & lead time. */
router.get(MOUNT + '/alerts/replenish', auth(['stock.purchase', 'stock.view']), http((req, res) => {
  const cfg = loadSetting(req.storeId, 'tax', DEFAULTS.tax);
  const rows = stockHealth({ storeId: req.storeId, days: cfg.consumption_window_days, lookaheadDays: cfg.alert_lookahead_days })
    .filter((h) => h.item_type === 'raw' && h.status !== 'ok')
    .map((h) => {
      const need = Math.max(0, Math.ceil((h.avg_daily || 0) * ((h.lead_time_days || 3) + 3) + (h.safety_stock || 0) - h.stock_qty));
      return {
        item_id: h.id, name: h.name, unit: h.unit, stock_qty: h.stock_qty, avg_daily: h.avg_daily,
        days_to_stockout: h.days_to_stockout, stockout_date: h.stockout_date, status: h.status,
        lead_time_days: h.lead_time_days, supplier_name: h.supplier_name,
        suggested_qty: need, est_cost: Math.round(need * (h.cost_price || 0)),
      };
    })
    .sort((a, b) => (a.days_to_stockout ?? 999) - (b.days_to_stockout ?? 999));
  res.json({ items: rows, total_est_cost: rows.reduce((s, r) => s + r.est_cost, 0) });
}));
