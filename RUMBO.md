# RUMBO — Hacia dónde va Clumsyloop y por qué en este orden

Este documento es de estrategia, no de una función concreta. Explica las
decisiones que ya se tomaron, el orden en que hay que construir, y las
que quedaron abiertas a propósito.

## El diferenciador

Stop Motion Studio domina el rubro desde hace más de una década — ~2000
reseñas a 4.5★ solo en la vista que motivó este proyecto, cross-platform,
bien monetizado. Competir de frente como "otra app de stop motion, pero
más fácil" es una carrera de features contra alguien con diez años de
ventaja puliendo exactamente eso. No es ese el plan.

**El ángulo es dibujo + cámara en la misma línea de tiempo.** Se
comprobó — no se asumió — que ningún competidor serio hace esto:
Procreate Dreams, la herramienta de animación profesional de referencia,
exporta video (`.mp4`/`.mov`) o secuencia de imágenes crudas
(`.png`/`.jpg`/`.tiff`), pero la secuencia cruda es explícitamente para
llevarla a un compositor externo (After Effects), no para publicar. Ni
siquiera Procreate Dreams construyó un feed propio — se apoya en las
redes existentes con el hashtag `#procreatedreams`. Ninguna herramienta
de este mercado trata "dibujar sobre stop motion" como su función
central. Ese vacío es el producto.

**Consecuencia directa para el feed**: publica solo `.mp4`. La secuencia
de fotos cruda puede existir como export para power users más adelante,
pero no es contenido de feed — nadie en ningún lado de este mercado
publica una carpeta de fotos sueltas para que otro la mire.

## Las decisiones de plataforma, en el orden en que se cerraron

**1. Capacitor, no PWA pura.** Trace y Beautyapp son PWA porque no
necesitan ni cámara de precisión ni monetización agresiva. Este proyecto
necesita las dos cosas a la vez:
- **Cámara**: `getUserMedia` del navegador no da control fino de
  exposición/foco — para stop motion eso importa, es literalmente el
  mecanismo central del producto.
- **Descubrimiento y cobro**: el público (creadores de TikTok/Reels)
  encuentra herramientas buscando en el App Store, no instalando una PWA
  desde Safari. Y una suscripción vendida dentro de la app necesita
  StoreKit — Apple exige IAP para contenido digital, Stripe directo
  arriesga el rechazo en revisión.

El costo (US$99/año de membresía de desarrollador, ~15-30% de comisión de
Apple) es barato comparado con perder cualquiera de esas dos cosas.

**2. Firebase, no Supabase.** La recomendación inicial fue Supabase
(Postgres real, sin vendor lock-in, y ya conocido porque Dimel usa
Postgres). Se optó por Firebase por la madurez de su integración de
push notifications, particularmente pensando en una futura versión
Android — aunque v1 es solo iOS, así que esa ventaja específica no se
cobra todavía. Quedó anotado para no repetir el argumento si alguien
pregunta "¿por qué no Supabase?" en seis meses: la razón no es el precio
ni el modelo de datos, es notificaciones push a futuro.

**3. Solo iOS para el lanzamiento.** Capacitor comparte la mayoría del
código entre iOS y Android, pero cada plataforma nueva es más superficie
de testing — y el plugin nativo de cámara (ver abajo) hay que
construirlo dos veces si se lanza en ambas. Un solo mercado bien resuelto
antes de duplicar el trabajo.

**4. Moderación manual en v1.** Apple exige reporte + bloqueo + baja en
24h para cualquier app con contenido de usuarios — eso no es negociable,
está en el alcance desde el día uno. Lo que sí se pospuso es la
moderación **automática** (una API tipo Cloud Vision): sin tráfico real
no hay con qué calibrarla, y construirla antes de tener el primer
reporte real es resolver un problema que todavía no existe.

**5. Pinceles y paletas se portan de Trace tal cual, no se rediseñan.**
`core/brush.ts` (20 presets en 5 categorías: boceto, tinta, pintura,
textura, borrador — con generación de estampas y el filtro One Euro) y
el sistema de paletas de `state/store.ts` (`PaletteGroup` fijas +
`UserPalette` del usuario) ya están pulidos y probados en producción.
Beautyapp ya validó que `brush.ts` se porta bien a otro proyecto — su
`StrokeBuilder` de retoque nace de la misma base. Rehacerlos de cero
para Clumsyloop tiraría trabajo terminado a la basura sin ganar nada:
a diferencia del resto del motor, estas dos piezas no tienen ninguna
relación con cámara ni con monetización, así que no necesitan la
adaptación que sí le hace falta a `document.ts`/`engine.ts`.

## El riesgo técnico que va primero

**El plugin nativo de cámara no es un detalle de implementación, es el
riesgo que puede tumbar el proyecto entero.** El plugin estándar de
Capacitor solo toma una foto suelta; stop motion necesita bloquear
exposición, foco y balance de blancos fotograma a fotograma — si no se
resuelve bien, cada foto se re-expone sola y la secuencia final
parpadea, que es exactamente el problema que un stop-motion serio no
puede tener. Por eso las fases de construcción empiezan ahí y no por lo
fácil (la UI, el feed): si el plugin de cámara no se puede lograr con la
fidelidad necesaria, el resto del plan no importa.

## Fases de construcción

1. **Prototipo del plugin de cámara** (AVFoundation vía Capacitor) — el
   riesgo real, se valida primero, en dispositivo físico.
2. **Motor de captura + dibujo local**, sin nube — el producto tiene que
   funcionar completo offline antes de sumar backend.
3. **Firebase**: auth (Sign in with Apple) + entitlements + validación de
   recibos de StoreKit vía Cloud Function.
4. **Feed**: publicar, ver, compartir externo (share sheet nativo).
5. **Reporte y moderación manual** — requisito de Apple, no se puede
   saltar para llegar antes a revisión.
6. **Empaquetado y envío a revisión de Apple.**

## Modelo de negocio

Freemium: marca de agua y resolución limitada en el plan gratis,
suscripción para export limpio, más capas, y guardado en la nube. La
nube no es un lujo acá — un proyecto de stop motion son cientos de fotos,
y perder ese trabajo porque el iPad se quedó sin espacio es el tipo de
frustración que genera baja, no solo una carencia de feature.

## El nombre

**Clumsyloop.** Salió después de varias rondas de nombres descartados —
"motion"/"anima" como prefijo suena a herramienta de trabajo, no a algo
que alguien de 16-20 años quiere ver al lado de TikTok en su pantalla de
inicio; "blob"/"clumsy" solos están saturados en el App Store (ocho apps
distintas usan "Clumsy" como palabra suelta: Clumsy Ninja, Clumsy Cat,
Clumsy Bomb, entre otras); "sweesh" quedó descartado por el parecido
fonético con "Swoosh", el logo registrado de Nike — riesgo legal real
para un proyecto sin presupuesto de abogado, aunque no hubiera choque
exacto registrado.

"Clumsyloop" sobrevivió la verificación (sin choque de app ni de marca
para el compuesto exacto) y es el único nombre de toda la ronda que
**cuenta algo del producto** en vez de solo describirlo: "clumsy" es
justo el encanto de una animación hecha a mano — nada queda perfecto, y
eso es lo que la hace compartible en vez de una animación de estudio — y
"loop" es literal a lo que produce la app.

## Deudas conocidas / riesgos que quedan abiertos

- **La moderación manual no escala.** El día que haya tráfico real, un
  solo panel interno revisado a mano se va a quedar corto. No es
  problema de v1, pero conviene no olvidarlo — ver la sección de fases,
  punto 5.
- **Sin Android desde el día uno** significa sin ese mercado hasta que se
  decida abrirlo — la decisión de negocio, no la técnica, es la que
  determina cuándo.
- **El plugin nativo de cámara es la apuesta más grande del proyecto** y
  todavía no está prototipado. Todo lo demás en este documento asume que
  funciona; si no funciona con la fidelidad necesaria, este plan hay que
  revisarlo desde la fase 1.
