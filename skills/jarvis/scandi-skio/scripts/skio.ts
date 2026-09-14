/**
 * Skio command line.
 *
 *   skio.ts introspect [TypeName]      list tables, or one table's fields
 *   skio.ts sub <subscription-id>      one subscription in full
 *   skio.ts email <address>            find subscriptions by customer email
 *   skio.ts cancels --days 14          recent cancellations with cancel-flow context
 *   skio.ts gql '<query>' [--vars '{}']
 */
import {
  PRICED_SUBSCRIPTION_FIELDS,
  intervalDays,
  isDunning,
  isPaused,
  neverRebilled,
  paginate,
  skioGql,
  type LightSubscription,
} from '/home/app/kit/lib/skio.ts';
import { parseArgs } from '/home/app/kit/lib/args.ts';

const { command, rest, flag } = parseArgs({ value: ['vars'] });




const dump = (value: unknown) => console.log(JSON.stringify(value, null, 2));

switch (command) {
  case 'introspect': {
    const typeName = rest[0];
    if (!typeName) {
      const data = await skioGql<{ __schema: { queryType: { fields: Array<{ name: string }> } } }>(
        '{ __schema { queryType { fields { name } } } }',
      );
      const names = data.__schema.queryType.fields
        .map((f) => f.name)
        .filter((n) => !n.startsWith('__') && !n.endsWith('_aggregate'))
        .sort();
      console.log(`${names.length} queryable tables:\n`);
      console.log(names.join('\n'));
      console.log('\nRun `introspect <TypeName>` to see a table\'s fields.');
      break;
    }

    const data = await skioGql<{
      __type: { fields: Array<{ name: string; type: { name?: string; ofType?: { name?: string } } }> } | null;
    }>(
      `{ __type(name: "${typeName}") { fields { name type { name ofType { name } } } } }`,
    );
    if (!data.__type) {
      console.error(`No type named "${typeName}". Run introspect with no argument for the list.`);
      process.exit(1);
    }
    for (const field of data.__type.fields) {
      const type = field.type.name ?? field.type.ofType?.name ?? '?';
      console.log(`  ${field.name.padEnd(32)} ${type}`);
    }
    break;
  }

  case 'sub': {
    const id = rest[0];
    if (!id) {
      console.error('Usage: skio.ts sub <subscription-id>');
      process.exit(1);
    }
    const data = await skioGql<{ Subscriptions: Array<Record<string, unknown>> }>(
      `query One($id: String!) {
         Subscriptions(where: { id: { _eq: $id } }) { ${PRICED_SUBSCRIPTION_FIELDS} }
       }`,
      { id },
    );
    const sub = data.Subscriptions[0];
    if (!sub) {
      console.error(`No subscription with id ${id}`);
      process.exit(1);
    }
    dump(sub);

    const light = sub as unknown as LightSubscription;
    console.log('\nInterpretation:');
    console.log(`  Billing interval: ${intervalDays(light)} days`);
    console.log(
      `  cyclesCompleted ${light.cyclesCompleted} — ${neverRebilled(light) ? 'has NEVER rebilled (checkout counts as cycle 1)' : `has rebilled ${(light.cyclesCompleted ?? 1) - 1} time(s)`}`,
    );
    if (isDunning(light)) console.log('  IN DUNNING — payment is failing. This is involuntary.');
    if (isPaused(light)) console.log('  PAUSED — excluded from the MRR ceiling.');
    console.log(
      `  Next rebill will carry Shopify tag "Subscription Order: ${(light.cyclesCompleted ?? 1) + 1}"`,
    );
    break;
  }

  case 'email': {
    const address = rest[0];
    if (!address) {
      console.error('Usage: skio.ts email <address>');
      process.exit(1);
    }
    const data = await skioGql<{ Subscriptions: LightSubscription[] }>(
      `query ByEmail($email: String!) {
         Subscriptions(where: { StorefrontUser: { email: { _eq: $email } } }) {
           id status statusContext createdAt cancelledAt nextBillingDate
           cyclesCompleted currencyCode
           BillingPolicy { interval intervalCount }
           StorefrontUser { email }
         }
       }`,
      { email: address },
    );
    if (!data.Subscriptions.length) {
      console.log(`No subscriptions for ${address}`);
      break;
    }
    console.table(
      data.Subscriptions.map((sub) => ({
        id: sub.id,
        status: sub.status,
        context: sub.statusContext ?? '',
        created: sub.createdAt.slice(0, 10),
        cancelled: sub.cancelledAt?.slice(0, 10) ?? '',
        nextBilling: sub.nextBillingDate?.slice(0, 10) ?? '',
        cycles: sub.cyclesCompleted,
        intervalDays: intervalDays(sub),
      })),
    );
    break;
  }

  case 'cancels': {
    const days = Number(flag('days') ?? 14);
    const since = new Date(Date.now() - days * 864e5).toISOString();

    // Filtered on updatedAt, never on cancelledAt — see the indexing trap.
    const subs = await paginate<LightSubscription>(
      `query RecentCancels($limit: Int!, $offset: Int!, $since: timestamptz!) {
         Subscriptions(
           where: { status: { _eq: "CANCELLED" }, updatedAt: { _gt: $since } }
           order_by: { updatedAt: asc }
           limit: $limit offset: $offset
         ) {
           id status statusContext createdAt cancelledAt updatedAt
           nextBillingDate cyclesCompleted currencyCode
           BillingPolicy { interval intervalCount }
           StorefrontUser { email }
         }
       }`,
      'Subscriptions',
      { since },
      500,
    );

    const voluntary = subs.filter((s) => !s.statusContext);
    const involuntary = subs.filter((s) => Boolean(s.statusContext));
    const firstCycle = subs.filter(neverRebilled);

    console.log(`\nCancellations in the last ${days} days: ${subs.length}\n`);
    console.log(`  voluntary (no statusContext)   ${voluntary.length}`);
    console.log(`  involuntary (dunning etc.)     ${involuntary.length}`);
    console.log(
      `  never rebilled (cycles <= 1)   ${firstCycle.length}  — cancelled before their first rebill`,
    );
    console.log(
      '\nFiltered on updatedAt, not cancelledAt: business-date columns are unindexed and time out.',
    );
    console.log('For rates and trends over time, use scandi-profit-api /api/cancellations.');
    break;
  }

  case 'gql': {
    const query = rest[0];
    if (!query) {
      console.error("Usage: skio.ts gql '<query>' [--vars '{...}']");
      process.exit(1);
    }
    const variables = flag('vars') ? (JSON.parse(flag('vars')!) as Record<string, unknown>) : {};
    dump(await skioGql(query, variables));
    break;
  }

  default:
    console.error(
      'Commands:\n' +
        '  introspect [Type]   list tables, or one table\'s fields\n' +
        '  sub <id>            one subscription, with the semantics spelled out\n' +
        '  email <address>     find subscriptions by customer email\n' +
        '  cancels --days N    recent cancellations, split voluntary vs involuntary\n' +
        "  gql '<query>'       raw GraphQL",
    );
    process.exit(1);
}
