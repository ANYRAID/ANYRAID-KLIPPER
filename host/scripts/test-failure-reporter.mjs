// Preserve exit metadata hidden by the ordinary spec reporter. No retries,
// process hooks, arbitrary error serialization, or product runtime changes.
const countKeys = ['tests', 'failed', 'passed', 'cancelled', 'skipped', 'todo', 'topLevel', 'suites'];
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export default async function* testFailureReporter(events) {
  for await (const {type, data} of events) {
    if (type === 'test:fail') {
      const truncatedFields = [];
      const text = (value, field) => {
        if (typeof value !== 'string') return null;
        if (value.length > 512) truncatedFields.push(field);
        return value.slice(0, 512);
      };
      const error = data.details?.error;
      yield JSON.stringify({nodeTestFailure: {
        schema: 1, node: process.version,
        file: text(data.file, 'file'), name: text(data.name, 'name'),
        line: integer(data.line), column: integer(data.column), nesting: integer(data.nesting),
        error: {
          code: text(error?.code, 'code'), failureType: text(error?.failureType, 'failureType'),
          exitCode: integer(error?.exitCode), signal: text(error?.signal, 'signal'),
          causeCode: text(error?.cause?.code, 'causeCode'),
        }, truncatedFields,
      }}) + '\n';
    } else if (type === 'test:summary' && data.file === undefined) {
      yield JSON.stringify({nodeTestObservation: {
        schema: 1, node: process.version,
        success: typeof data.success === 'boolean' ? data.success : null,
        counts: Object.fromEntries(countKeys.map(key => [key, integer(data.counts?.[key])])),
      }}) + '\n';
    }
  }
}
