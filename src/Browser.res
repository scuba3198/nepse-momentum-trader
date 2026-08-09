type response

@val external fetch: string => Promise.t<response> = "fetch"
@get external ok: response => bool = "ok"
@send external text: response => Promise.t<string> = "text"
@val external online: bool = "navigator.onLine"
@val external baseUrl: string = "import.meta.env.BASE_URL"
