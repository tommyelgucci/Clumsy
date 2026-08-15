# Checkpoint — Bitácora de avances

### 2026-08-15 — Nace el proyecto: arquitectura y nombre, sin código todavía

Surgió comparando el catálogo de proyectos existentes del dueño (Dimel,
Trace, Beautyapp, SkySimAcademy, Draw) para evaluar cuál tenía más
recorrido comercial, y de ahí a una pregunta puntual: ¿vale la pena un
proyecto de animación nuevo, basado en la arquitectura de Trace, pero
diseñado para monetizar desde el día uno en vez de quedarse gratis y
local como Trace?

**La investigación de mercado vino primero que el código.** Se comprobó
—no se asumió— que Stop Motion Studio domina el rubro de stop motion
puro (~2000 reseñas, 4.5★, más de una década en el mercado): competir de
frente ahí es una carrera perdida. Se buscó el ángulo distinto revisando
qué hace Procreate Dreams, la herramienta profesional de referencia en
animación: exporta video o secuencia de imágenes crudas, pero ni siquiera
ellos construyeron un feed propio — la secuencia cruda es explícitamente
para pipelines profesionales, no para compartir. Ese fue el dato que
cerró la decisión: dibujo + cámara en la misma línea de tiempo, con feed
de solo `.mp4`, es un ángulo que nadie en este mercado está sirviendo.

**Se corrió el skill `architect`** (con las carpetas de referencia
`questions/`/`knowledge/` no disponibles en este entorno — se armó el
proceso con criterio propio, mismo rigor: entrevista, un gate de
confirmación, nada de código antes de cerrar decisiones) para bajar la
idea a arquitectura concreta. Decisiones cerradas, en orden: Capacitor
(no PWA — la cámara necesita control nativo de exposición/foco que la
web no da, y el público llega por búsqueda de App Store, no instalando
una PWA) → Firebase (no Supabase — por madurez de push notifications
pensando en una futura versión Android) → feed social con clips
publicables → moderación manual para v1 (reporte + baja en 24h, mínimo
que exige Apple para UGC) → solo iOS para el lanzamiento. El detalle
completo con el porqué de cada una está en `RUMBO.md`.

**El nombre costó más que la arquitectura.** Varias rondas descartadas:
"MotionLobby"/"MotionLair" (suenan a herramienta de trabajo, no a algo
que alguien de 16-20 años quiere al lado de TikTok), "Squish"/"Clayo"/
"Framey"/"Wiggle" (ya existían), "Nudge"/"Sprocket"/"Blorp"/"Glob"
(colisiones confirmadas por búsqueda), "Blobbymotion"/"Blobby" solo
(el territorio "blob" está saturado — tres apps publicadas solo con esa
palabra), "Sweesh" (descartado por parecido fonético con "Swoosh", marca
registrada de Nike — riesgo legal real, no solo estético), "Clumsy" solo
(saturado: ocho apps distintas lo usan como palabra suelta para juegos
casuales). Terminó en **Clumsyloop** — compuesto sin choques, y el único
que cuenta algo del producto (la imperfección hecha a mano es el
encanto) en vez de solo describirlo.

Se creó el repositorio `tommyelgucci/Clumsy` (vacío) y se escribieron los
tres documentos de arranque (`CLAUDE.md`, `RUMBO.md`, este archivo). El
siguiente paso real, marcado en `RUMBO.md`, es prototipar el plugin
nativo de cámara sobre AVFoundation — es el riesgo técnico que puede
tumbar el proyecto entero, así que va antes que cualquier pantalla.
