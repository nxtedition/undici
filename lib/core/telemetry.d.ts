import type { Telemetry } from '../../index.js'

export function setTelemetry (dispatcher: object, telemetry?: Telemetry | false | null): void
export function getTelemetry (dispatcher: object): Telemetry | false | null | undefined
export function prepareTelemetry<O extends object, H extends object> (opts: O, handler: H, telemetry?: Telemetry | false | null): { opts: O; handler: H }
export function dispatchTelemetry<O extends object, H extends object, R> (dispatch: (opts: O, handler: H) => R, opts: O, handler: H): R
export function hasTelemetryContext (opts: object): boolean
