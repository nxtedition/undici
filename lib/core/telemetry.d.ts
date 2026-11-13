export function prepareTelemetry<O extends object, H extends object> (opts: O, handler: H): { opts: O; handler: H }
export function dispatchTelemetry<O extends object, H extends object, R> (dispatch: (opts: O, handler: H) => R, opts: O, handler: H): R
export function hasTelemetryContext (opts: object): boolean

export function getTelemetryFields (opts: object): ReadonlySet<string> | undefined
