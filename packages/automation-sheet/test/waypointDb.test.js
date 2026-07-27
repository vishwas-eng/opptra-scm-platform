import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapNeonRow } from '../src/waypointDb.js';

test('mapNeonRow: maps real SalesOrder/SoLineItem/Appointment join columns to Waypoint-shaped keys', () => {
  const row = {
    so_code: 'OPT-SO-000651', so_status: 'CREATED', po_code: 'P4875811',
    dispatch_warehouse_code: 'Opp_RSG_MH', marketplace: 'ZEPTO_B2B',
    brands: 'Acme,Beta', total_units: 42, so_value: '42600.00',
    so_creation_date: new Date('2026-07-23T11:29:41.000Z'), ship_to_city: 'Chennai',
    appointment_date: new Date('2026-07-25T00:00:00.000Z'), appointment_id: 'APT-9',
  };
  const mapped = mapNeonRow(row);
  assert.equal(mapped['SO Code'], 'OPT-SO-000651');
  assert.equal(mapped['SO Status'], 'CREATED');
  assert.equal(mapped['PO Code'], 'P4875811');
  assert.equal(mapped.Warehouse, 'Opp_RSG_MH');
  assert.equal(mapped.Marketplace, 'ZEPTO_B2B');
  assert.equal(mapped['Brand(s)'], 'Acme,Beta');
  assert.equal(mapped['Total Units'], 42);
  assert.equal(mapped['Ship-to City'], 'Chennai');
  assert.equal(mapped['Appt ID'], 'APT-9');
});

test('mapNeonRow: null joins (no line items / no appointment) never crash, default to empty', () => {
  const row = {
    so_code: 'SO1', so_status: 'CREATED', po_code: 'PO1',
    dispatch_warehouse_code: null, marketplace: null, brands: null, total_units: null,
    so_value: null, so_creation_date: null, ship_to_city: null,
    appointment_date: null, appointment_id: null,
  };
  const mapped = mapNeonRow(row);
  assert.equal(mapped.Warehouse, '');
  assert.equal(mapped['Brand(s)'], '');
  assert.equal(mapped['Total Units'], 0);
  assert.equal(mapped['Appt ID'], '');
});
