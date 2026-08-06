import { test } from 'node:test';
import { buildWaypointSOQuery } from '../src/waypointDb.js';
import assert from 'node:assert/strict';
import { mapNeonRow } from '../src/waypointDb.js';
import { mapMarketplaceDropdown, marketplaceLabelFromCustomer, phase1Mapper } from '../src/schema.js';

test('mapNeonRow: maps real SalesOrder/SoLineItem/Appointment join columns to Waypoint-shaped keys', () => {
  const row = {
    so_code: 'OPT-SO-000651', so_status: 'CREATED', po_code: 'P4875811',
    dispatch_warehouse_code: 'Opp_RSG_MH', marketplace: 'ZEPTO_B2B',
    customer_code: 'B2B00006_KTP_HR',
    brands: 'Acme,Beta', total_units: 42, so_value: '42600.00',
    so_creation_date: new Date('2026-07-23T11:29:41.000Z'), ship_to_city: 'Chennai',
    appointment_date: new Date('2026-07-25T00:00:00.000Z'), appointment_id: 'APT-9',
  };
  const mapped = mapNeonRow(row);
  assert.equal(mapped['SO Code'], 'OPT-SO-000651');
  assert.equal(mapped['SO Status'], 'CREATED');
  assert.equal(mapped['PO Code'], 'P4875811');
  assert.equal(mapped.Warehouse, 'Opp_RSG_MH');
  assert.equal(mapped.Customer, 'B2B00006_KTP_HR');
  assert.equal(mapped.Marketplace, 'ZEPTO_B2B');
  assert.equal(mapped['Brand(s)'], 'Acme,Beta');
  assert.equal(mapped['Total Units'], 42);
  assert.equal(mapped['Ship-to City'], 'Chennai');
  assert.equal(mapped['Appt ID'], 'APT-9');
});

test('mapNeonRow: null joins (no line items / no appointment) never crash, default to empty', () => {
  const row = {
    so_code: 'SO1', so_status: 'CREATED', po_code: 'PO1',
    dispatch_warehouse_code: null, marketplace: null, customer_code: null, brands: null, total_units: null,
    so_value: null, so_creation_date: null, ship_to_city: null,
    appointment_date: null, appointment_id: null,
  };
  const mapped = mapNeonRow(row);
  assert.equal(mapped.Warehouse, '');
  assert.equal(mapped.Customer, '');
  assert.equal(mapped['Brand(s)'], '');
  assert.equal(mapped['Total Units'], 0);
  assert.equal(mapped['Appt ID'], '');
});

test('buildWaypointSOQuery: no filters → suppressed guard + LIMIT only, fully parameterized', () => {
  const { sql, params } = buildWaypointSOQuery({});
  assert.match(sql, /WHERE so\.suppressed = false\s*\n\s*ORDER BY/);
  assert.deepEqual(params, [50]);
});

test('buildWaypointSOQuery: every filter lands as a $n parameter, never inline text', () => {
  const { sql, params } = buildWaypointSOQuery({
    soCode: ' OPT-SO-1 ', status: 'created', customer: "x'; DROP TABLE--",
    warehouse: 'Opp_RSG_MH', createdFrom: '2026-08-01', limit: 999,
  });
  assert.match(sql, /so\.so_code = \$1/);
  assert.match(sql, /upper\(so\.so_status\) = upper\(\$2\)/);
  assert.match(sql, /upper\(so\.customer_code\) = upper\(\$3\)/);
  assert.match(sql, /upper\(so\.dispatch_warehouse_code\) = upper\(\$4\)/);
  assert.match(sql, /so\.so_creation_date >= \$5/);
  assert.match(sql, /LIMIT \$6/);
  // The injection attempt exists only as a bound parameter, never in the SQL text.
  assert.equal(sql.includes('DROP TABLE'), false);
  assert.equal(params[2], "x'; DROP TABLE--");
  assert.equal(params[0], 'OPT-SO-1', 'values are trimmed');
  assert.equal(params[5], 200, 'limit capped at 200');
});

test('buildWaypointSOQuery: limit floor is 1 and default 50 on garbage', () => {
  assert.equal(buildWaypointSOQuery({ limit: -5 }).params.at(-1), 1);
  assert.equal(buildWaypointSOQuery({ limit: 'abc' }).params.at(-1), 50);
});

test('mapMarketplaceDropdown: Customer codes resolve to the right Marketplace labels', () => {
  assert.equal(mapMarketplaceDropdown('ETRADE_MARKETING_PRIVATE_LIMITED_HR_122103'), 'AZ Etrade');
  assert.equal(mapMarketplaceDropdown('KKOC_ISK3_MH4_421302'), 'AZ KKOC');
  assert.equal(mapMarketplaceDropdown('COCOBLU_MH01_421302'), 'cocoblu');
  assert.equal(mapMarketplaceDropdown('CLICKTECH_MH_BOM5_421302_RETAIL'), 'clickTech');
  assert.equal(mapMarketplaceDropdown('coco blue'), 'cocoblu');
  assert.equal(mapMarketplaceDropdown('Cocoa Blue'), 'cocoblu');
  assert.equal(mapMarketplaceDropdown('clicktag'), 'clickTech');
  assert.equal(mapMarketplaceDropdown('ClickTag'), 'clickTech');
  assert.equal(mapMarketplaceDropdown('ClickTech'), 'clickTech');
  assert.equal(mapMarketplaceDropdown('BLINKIT_M12_MH_421302'), 'Blinkit');
  assert.equal(mapMarketplaceDropdown('Big_Basket_Mumbai_FMCG_DC_400028'), 'BigBasket');
  assert.equal(mapMarketplaceDropdown('BIGBASKET_B2B_SOR'), 'BigBasket');
  assert.equal(mapMarketplaceDropdown('SwiggyInstaKA01'), 'Instamart');
  assert.equal(mapMarketplaceDropdown('RETAILEZ_PVT_MH_421302'), 'AZ RetailEZ');
});

test('marketplaceLabelFromCustomer: Amazon family + Swiggy/Flipkart short names; else customer as-is', () => {
  assert.equal(marketplaceLabelFromCustomer('ETRADE_MARKETING_PRIVATE_LIMITED_HR_122103', 'AMAZON_B2B'), 'E-Trade');
  assert.equal(marketplaceLabelFromCustomer('KKOC_ISK3_MH4_421302', 'AMAZON_B2B'), 'KKOC');
  assert.equal(marketplaceLabelFromCustomer('COCOBLU_MH01_421302', 'AMAZON_B2B'), 'cocoblu');
  assert.equal(marketplaceLabelFromCustomer('CLICKTECH_MH_BOM5_421302_RETAIL', 'AMAZON_B2B'), 'clickTech');
  assert.equal(marketplaceLabelFromCustomer('Cocoa Blue', 'AMAZON_B2B'), 'cocoblu');
  assert.equal(marketplaceLabelFromCustomer('coco blue', ''), 'cocoblu');
  assert.equal(marketplaceLabelFromCustomer('ClickTag', 'AMAZON_B2B'), 'clickTech');
  assert.equal(marketplaceLabelFromCustomer('clicktag', ''), 'clickTech');
  assert.equal(marketplaceLabelFromCustomer('SwiggyInstaKA01', 'INSTAMART_B2B'), 'Swiggy');
  assert.equal(marketplaceLabelFromCustomer('CLOUDSTORE_SWIGGYINSTA_421302_MH', 'INSTAMART_B2B'), 'Swiggy');
  assert.equal(marketplaceLabelFromCustomer('FK_SOMETHING', 'FLIPKART_B2B'), 'Flipkart');
  assert.equal(marketplaceLabelFromCustomer('Big_Basket_Mumbai_FMCG_DC_400028', 'BIGBASKET_B2B_SOR'), 'Big_Basket_Mumbai_FMCG_DC_400028');
  assert.equal(marketplaceLabelFromCustomer('BLINKIT_M12_MH_421302', 'BLINKIT_B2B'), 'BLINKIT_M12_MH_421302');
  assert.equal(marketplaceLabelFromCustomer('RETAILEZ_PVT_MH_421302', 'AMAZON_B2B'), 'RETAILEZ_PVT_MH_421302');
});

test('phase1Mapper: Marketplace uses short Amazon/Swiggy labels, Origin City is not the warehouse', () => {
  const row = phase1Mapper({
    'SO Code': 'OPT-SO-000685',
    'SO Status': 'CREATED',
    Marketplace: 'AMAZON_B2B',
    Customer: 'CLICKTECH_MH_BOM5_421302_RETAIL',
    Warehouse: 'Opp_RSG_MH',
    'Brand(s)': 'Belkin',
    'Total Units': 10,
  });
  assert.equal(row.Marketplace, 'clickTech');
  assert.equal(row['Pickup Wh Name'], 'Opp_RSG_MH');
  assert.equal(row['Origin City'], '', 'warehouse must not be copied into Origin City');
});
