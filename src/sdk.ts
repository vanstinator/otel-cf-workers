import { Attributes, context, Exception, propagation, SpanKind, SpanOptions, trace } from '@opentelemetry/api'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { SemanticAttributes, SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'
import { WorkerTracerProvider } from './provider'
import { OTLPFetchTraceExporter } from './exporter'
import { Resource } from '@opentelemetry/resources'
import { instrumentEnv } from './env'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

export interface WorkerTraceConfig {
	exporter: {
		url: string
		headers?: Record<string, string>
	}
	serviceName: string
	serviceNamespace?: string
	serviceVersion?: string
}

type FetchHandler<E, C> = ExportedHandlerFetchHandler<E, C>

const sanitiseURL = (url: string): string => {
	const u = new URL(url)
	return `${u.protocol}//${u.host}${u.pathname}${u.search}`
}

const gatherRequestAttributes = (request: Request): Attributes => {
	const attrs: Record<string, string | number> = {}
	const headers = request.headers
	// attrs[SemanticAttributes.HTTP_CLIENT_IP] = '1.1.1.1'
	attrs[SemanticAttributes.HTTP_METHOD] = request.method
	attrs[SemanticAttributes.HTTP_URL] = sanitiseURL(request.url)
	if (headers.has('user-agent')) {
		attrs[SemanticAttributes.HTTP_USER_AGENT] = headers.get('user-agent')!
	}
	return attrs
}

const gatherIncomingCfAttributes = (request: Request): Attributes => {
	const attrs: Record<string, string | number> = {}
	attrs[SemanticAttributes.HTTP_SCHEME] = request.cf?.httpProtocol as string
	attrs['net.colo'] = request.cf?.colo as string
	attrs['net.country'] = request.cf?.country as string
	attrs['net.request_priority'] = request.cf?.requestPriority as string
	attrs['net.tls_cipher'] = request.cf?.tlsCipher as string
	attrs['net.tls_version'] = request.cf?.tlsVersion as string
	attrs['net.asn'] = request.cf?.asn as number
	attrs['net.tcp_rtt'] = request.cf?.clientTcpRtt as number
	return attrs
}

const gatherOutgoingCfAttributes = (cf: RequestInitCfProperties): Attributes => {
	const attrs: Record<string, string | number> = {}
	Object.keys(cf).forEach((key) => {
		const value = cf[key]
		if (typeof value === 'string' || typeof value === 'number') {
			attrs[`cf.${key}`] = value
		} else {
			attrs[`cf.${key}`] = JSON.stringify(value)
		}
	})
	return attrs
}

const gatherResponseAttributes = (response: Response): Attributes => {
	const attrs: Record<string, string | number> = {}
	attrs[SemanticAttributes.HTTP_STATUS_CODE] = response.status
	return attrs
}

const createResource = (config: WorkerTraceConfig): Resource => {
	const workerResourceAttrs = {
		[SemanticResourceAttributes.CLOUD_PROVIDER]: 'cloudflare',
		[SemanticResourceAttributes.CLOUD_PLATFORM]: 'cloudflare.workers',
		[SemanticResourceAttributes.CLOUD_REGION]: 'earth',
		[SemanticResourceAttributes.FAAS_NAME]: '//TODO',
		[SemanticResourceAttributes.FAAS_VERSION]: '//TODO',
		[SemanticResourceAttributes.FAAS_MAX_MEMORY]: 128,
		[SemanticResourceAttributes.TELEMETRY_SDK_LANGUAGE]: 'JavaScript',
		[SemanticResourceAttributes.TELEMETRY_SDK_NAME]: '@microlabs/otel-workers-sdk',
	}
	const serviceResource = new Resource({
		[SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
		[SemanticResourceAttributes.SERVICE_NAMESPACE]: config.serviceNamespace,
		[SemanticResourceAttributes.SERVICE_VERSION]: config.serviceVersion,
	})
	const resource = new Resource(workerResourceAttrs)
	return resource.merge(serviceResource)
}

function extractConfigFromEnv(config: WorkerTraceConfig, env: Record<string, unknown>) {
	Object.keys(env).forEach((key) => {
		key = key.toLowerCase()
		if (key.startsWith('otel.headers.')) {
			const name = key.replace('otel.headers.', '')
			const value = env[key] as string
			config.exporter = config.exporter || {}
			config.exporter.headers = config.exporter.headers || {}
			config.exporter.headers[name] = value
		}
	})
}

const init = (config: WorkerTraceConfig) => {
	const resource = createResource(config)
	const exporter = new OTLPFetchTraceExporter(config.exporter)
	const provider = new WorkerTracerProvider(new SimpleSpanProcessor(exporter), resource)
	provider.register()
}

let cold_start = true
const proxyFetchHandler = <E, C>(fetchHandler: FetchHandler<E, C>, config: WorkerTraceConfig): FetchHandler<E, C> => {
	return new Proxy(fetchHandler, {
		apply: (target, thisArg, argArray): Promise<Response> => {
			const request = argArray[0] as Request
			const env = argArray[1] as Record<string, unknown>
			extractConfigFromEnv(config, env)
			init(config)
			argArray[1] = instrumentEnv(env, config)

			const ctx = propagation.extract(context.active(), request.headers, {
				get(headers, key) {
					return headers.get(key) || undefined
				},
				keys(headers) {
					return [...headers.keys()]
				},
			})

			const tracer = trace.getTracer('fetchHandler')
			const options: SpanOptions = {
				kind: SpanKind.SERVER,
			}

			const promise = tracer.startActiveSpan('fetchHandler', options, ctx, async (span) => {
				span.setAttribute(SemanticAttributes.FAAS_TRIGGER, 'http')
				span.setAttribute(SemanticAttributes.FAAS_COLDSTART, cold_start)
				cold_start = false

				span.setAttributes(gatherRequestAttributes(request))
				span.setAttributes(gatherIncomingCfAttributes(request))

				try {
					const response: Response = await Reflect.apply(target, thisArg, argArray)
					span.setAttributes(gatherResponseAttributes(response))
					span.end()

					return response
				} catch (error) {
					span.recordException(error as Exception)
					span.end()
					return new Response('Server error.', { status: 500 })
				}
			})
			return promise
		},
	})
}

const instrumentGlobalFetch = (): void => {
	if (!globalThis.orig_fetch) {
		globalThis.orig_fetch = globalThis.fetch
		const new_fetch = new Proxy(globalThis.fetch, {
			apply: (target, thisArg, argArray): ReturnType<typeof fetch> => {
				const tracer = trace.getTracer('fetch')
				const options: SpanOptions = {
					kind: SpanKind.CLIENT,
				}
				const request = new Request(argArray[0], argArray[1])
				propagation.inject(context.active(), request.headers, {
					set: (h, k, v) => h.set(k, typeof v === 'string' ? v : String(v)),
				})
				const promise = tracer.startActiveSpan(`fetch: ${request.url}`, options, async (span) => {
					span.setAttributes(gatherRequestAttributes(request))
					if (request.cf) span.setAttributes(gatherOutgoingCfAttributes(request.cf))
					const response: Response = await Reflect.apply(target, thisArg, [request])
					span.setAttributes(gatherResponseAttributes(response))
					span.end()
					return response
				})
				return promise
			},
		})
		globalThis.fetch = new_fetch
	}
}

const instrument = <E, Q, C>(
	handler: ExportedHandler<E, Q, C>,
	config: WorkerTraceConfig
): ExportedHandler<E, Q, C> => {
	propagation.setGlobalPropagator(new W3CTraceContextPropagator())
	instrumentGlobalFetch()
	if (handler.fetch) {
		handler.fetch = proxyFetchHandler(handler.fetch, config)
	}
	return handler
}

export { instrument }
