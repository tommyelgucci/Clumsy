# CLAUDE.md

Contexto para agentes que trabajen en este repositorio. Léelo antes de tocar
código.

## Estado del repositorio

**A la fecha de este archivo (2026-08-15) el repo no tiene código.** Lo que
hay son los tres documentos de planificación (`CLAUDE.md`, `RUMBO.md`,
`checkpoint.md`), producto de una sesión de diseño de arquitectura con el
skill `architect`. Si estás leyendo esto para empezar a construir, no
asumas que existe nada más — no hay `package.json`, no hay `src/`, no hay
proyecto de Xcode. El primer paso real está en `RUMBO.md`, sección "Fases
de construcción", y **empieza por el riesgo técnico**, no por lo fácil.

## Qué es Clumsyloop

App de animación híbrida: captura fotograma a fotograma con la cámara
(stop motion / claymation) y permite dibujar por encima, en la misma
línea de tiempo — rotoscopia, efectos, bocadillos de diálogo, fondos
ilustrados. El diferenciador frente a Stop Motion Studio (el incumbente
del rubro) es exactamente eso: ellos no tienen motor de dibujo, nosotros
sí. Público: creadores de contenido corto (TikTok/Reels), no el
hobbista de stop motion puro. Ver `RUMBO.md` para el porqué completo.

Motor técnico basado en el mismo patrón que **Trace** (otro proyecto del
mismo dueño: dibujo/animación 2D en WebGL2) — no es el mismo código, es
la misma arquitectura de capas (`core/` puro sin DOM, `gl/` como único
punto de contacto con WebGL, `state/` con Zustand, `ui/` con React).
Portalo desde ahí como referencia de diseño, no copies archivos sin
adaptar: Trace no tiene cámara ni monetización, este proyecto sí.

## Por dónde empezar

| Querés saber… | Leé |
|---|---|
| Hacia dónde va el producto y por qué estas decisiones en este orden | `RUMBO.md` |
| Qué se hizo y cuándo | `checkpoint.md` — entradas nuevas **arriba** |

## Comandos (una vez armado el scaffold)

```bash
npm run dev              # servidor Vite, para iterar la UI sin abrir Xcode
npm run build             # tsc -b && vite build
npm run lint               # eslint, debe salir sin warnings
npx cap sync ios           # copia el build web al proyecto iOS nativo
npx cap open ios           # abre Xcode para compilar/correr en simulador o dispositivo
```

**El simulador de iOS no sirve para probar la cámara.** Todo lo que toque
captura de fotogramas (exposición, foco, el plugin nativo) se prueba en un
dispositivo físico — el simulador no tiene cámara real y el comportamiento
de AVFoundation no es equivalente.

## Cómo se firman los commits

Mismo criterio que el resto de los repositorios de este dueño:

```bash
git config user.name  "tommyelgucci"
git config user.email "299895314+tommyelgucci@users.noreply.github.com"
git config commit.gpgsign false
```

Sin `Co-Authored-By: Claude`, sin `Claude-Session:`, sin el enlace de
`claude.ai/code` en el cuerpo del commit. El `commit.gpgsign false` no es
opcional — sin él, el commit sale a nombre del dueño pero firmado con una
clave del sandbox, y GitHub lo marca `unknown_key`.

## Convenciones de arquitectura

**Todo el color va premultiplicado por alfa** en texturas, shaders y
buffers leídos con `readPixels` — mismo invariante que Trace y Beautyapp,
copiado a propósito porque romperlo produce fallos visuales sutiles
(colores con halo, bordes oscuros).

**El documento es un objeto mutable, no estado de React.** Mismo patrón
`engine.touch()` → incrementa `revision` → un hook `useEngineRevision()`
fuerza el re-render. Meter el documento (fotogramas, capas) en estado de
React duplicaría megabytes en cada captura.

**La captura de cámara necesita un plugin nativo a medida**, no el plugin
estándar de Capacitor (`@capacitor/camera`, que solo toma una foto suelta
vía `UIImagePickerController`). Stop motion necesita bloquear exposición,
foco y balance de blancos **entre** fotogramas — si cada foto se re-expone
sola, la secuencia parpadea. Esto envuelve AVFoundation directamente. Es
el mayor riesgo técnico del proyecto — ver `RUMBO.md`.

**Verificación en dispositivo real, no solo en el compilador.** Como en
Trace y Beautyapp: `tsc` no ve un pipeline WebGL roto ni un plugin nativo
que compila pero no bloquea el foco correctamente.

## Backend

- **Firebase**: Auth (Sign in with Apple como método principal), Firestore
  (colección `clips` para el feed, cronológico, sin algoritmo), Storage
  (los `.mp4` publicados).
- **Pagos**: StoreKit 2 del lado del cliente. El derecho de suscripción
  **nunca se confía del cliente** — una Cloud Function valida el recibo
  contra la App Store Server API y recién ahí escribe el estado en
  Firestore.
- **Compartir externo**: share sheet nativo de iOS hacia
  Instagram/TikTok/X/Threads/Facebook, no integración de API por
  plataforma — evita depender de aprobaciones de terceros que no
  controlamos.

## Alcance de v1

**Incluye**: captura + dibujo en la misma línea de tiempo, export limpio
de pago (marca de agua en el plan gratis), feed propio de `.mp4`,
compartir externo, reporte de contenido + baja manual, suscripción vía
StoreKit.

**Excluye a propósito** (no es deuda, es alcance): Android, comentarios,
seguidores, feed algorítmico, moderación automática, mensajes directos.
No agregues ninguna de estas sin que el dueño lo pida — cada una cambia
el perfil de cumplimiento de Apple (especialmente moderación) o el
alcance de infraestructura.

## Cumplimiento de Apple para contenido generado por usuarios

El feed público **obliga** a tener: reporte de contenido, bloqueo de
usuarios abusivos, y capacidad del equipo de bajar contenido reportado en
24 horas. Sin esto, Apple rechaza la app en revisión — no es una mejora
opcional, es un requisito de guideline para cualquier app con UGC. v1 lo
resuelve manual (reporte → Cloud Function que oculta el clip → un panel
interno mínimo), no con moderación automática — ver `RUMBO.md` para el
porqué de esa secuencia.
