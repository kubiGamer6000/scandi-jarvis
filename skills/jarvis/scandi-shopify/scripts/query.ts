/**
 * Shopify command line.
 *
 *   query.ts ql "FROM sales SHOW total_sales, orders SINCE 2026-08-01 UNTIL 2026-08-31"
 *   query.ts sales --days 30 [--split]
 *   query.ts orders --search "created_at:>=2026-08-01" [--limit 200]
 *   query.ts gql "{ shop { name currencyCode } }"
 *
 * Flags: --csv <path>  --json  --days N  --from/--to YYYY-MM-DD
 */
import { writeFileSync } from 'node:fs';

import {
  ORDER_TAGS,
  graphql,
  orderTagFilter,
  paginateOrders,
  rowsToObjects,
  shopifyQl,
} from '/home/app/kit/lib/shopify.ts';
import { formatEur } from '/home/app/kit/lib/fx.ts';
import { parseArgs } from '/home/app/kit/lib/args.ts';

const { command, rest, flag, has, range } = parseArgs({
  value: ['search', 'limit', 'id'],
  boolean: ['split'],
});
const { from, to } = range(30);

function output(rows: Array<Record<string, unknown>>, label: string): void {
  const csvPath = flag('csv');
  if (csvPath) {
    const headers = Object.keys(rows[0] ?? {});
    const escape = (value: unknown) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))];
    writeFileSync(csvPath, csv.join('\n'), 'utf8');
    console.log(`${rows.length} rows -> ${csvPath}`);
    return;
  }
  if (has('json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`\n${label} (${rows.length} rows)\n`);
  console.table(rows.slice(0, 50));
  if (rows.length > 50) console.log(`... ${rows.length - 50} more. Use --csv to get all of them.`);
}

switch (command) {
  case 'ql': {
    const query = rest[0];
    if (!query) {
      console.error('Usage: query.ts ql "FROM sales SHOW total_sales SINCE ... UNTIL ..."');
      process.exit(1);
    }
    const table = await shopifyQl(query);
    output(rowsToObjects(table), 'ShopifyQL');
    break;
  }

  case 'sales': {
    // Split subscription rebills from one-time sales, which is what "how did
    // X sell" almost always means. Tags are the only reliable signal.
    const window = `SINCE ${from} UNTIL ${to}`;
    const metrics = 'total_sales, orders, returns';

    if (!has('split')) {
      const table = await shopifyQl(`FROM sales SHOW ${metrics}, gross_sales, discounts ${window}`);
      output(rowsToObjects(table), `Sales ${from} to ${to}`);
      break;
    }

    const [all, recurring, first] = await Promise.all([
      shopifyQl(`FROM sales SHOW ${metrics} ${window}`),
      shopifyQl(`FROM sales SHOW ${metrics} WHERE ${orderTagFilter(ORDER_TAGS.recurring)} ${window}`),
      shopifyQl(`FROM sales SHOW ${metrics} WHERE ${orderTagFilter(ORDER_TAGS.firstOrder)} ${window}`),
    ]);

    const total = (table: Awaited<ReturnType<typeof shopifyQl>>, column: string) =>
      rowsToObjects(table).reduce((sum, row) => sum + Number(row[column] ?? 0), 0);

    const allSales = total(all, 'total_sales');
    const recurringSales = total(recurring, 'total_sales');
    const firstSales = total(first, 'total_sales');
    const oneTime = allSales - recurringSales - firstSales;

    console.log(`\nSales ${from} to ${to}\n`);
    console.log(`Total            ${formatEur(allSales)}   ${total(all, 'orders')} orders`);
    console.log(`  rebills        ${formatEur(recurringSales)}   ${total(recurring, 'orders')} orders`);
    console.log(`  first sub      ${formatEur(firstSales)}   ${total(first, 'orders')} orders`);
    console.log(`  one-time       ${formatEur(oneTime)}   (derived by subtraction)`);
    console.log(
      `\nAOV is computed as SUM(total_sales)/SUM(orders) — ShopifyQL's own average_order_value\n` +
        `is only valid for a single day and cannot be averaged across this range.`,
    );
    break;
  }

  case 'orders': {
    const search = flag('search') ?? `created_at:>=${from} created_at:<=${to}`;
    const limit = Number(flag('limit') ?? 250);
    const fields = `
      id name createdAt tags displayFulfillmentStatus displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      shippingAddress { countryCodeV2 }
    `;

    interface Order {
      id: string;
      name: string;
      createdAt: string;
      tags: string[];
      displayFulfillmentStatus: string;
      displayFinancialStatus: string;
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      shippingAddress: { countryCodeV2: string } | null;
    }

    const rows: Array<Record<string, unknown>> = [];
    for await (const order of paginateOrders<Order>(fields, search)) {
      rows.push({
        name: order.name,
        createdAt: order.createdAt.slice(0, 10),
        total: Number(order.totalPriceSet.shopMoney.amount),
        currency: order.totalPriceSet.shopMoney.currencyCode,
        country: order.shippingAddress?.countryCodeV2 ?? '',
        fulfilment: order.displayFulfillmentStatus,
        financial: order.displayFinancialStatus,
        subscription: order.tags.some((t) => t.startsWith('Subscription')),
        tags: order.tags.join('|'),
      });
      if (rows.length >= limit) break;
    }
    output(rows, `Orders matching "${search}"`);
    break;
  }

  case 'gql': {
    const query = rest[0];
    if (!query) {
      console.error('Usage: query.ts gql "{ shop { name } }"');
      process.exit(1);
    }
    console.log(JSON.stringify(await graphql(query), null, 2));
    break;
  }

  default:
    console.error(
      'Commands:\n' +
        '  ql "<ShopifyQL>"        aggregates and breakdowns (prefer this)\n' +
        '  sales [--split]         revenue split into rebills / first sub / one-time\n' +
        '  orders [--search ...]   individual orders\n' +
        '  gql "<GraphQL>"         raw Admin API query\n' +
        'Flags: --days N | --from/--to YYYY-MM-DD | --limit N | --csv path | --json',
    );
    process.exit(1);
}
