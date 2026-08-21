import { Node, mergeAttributes } from '@tiptap/core';

/**
 * Un diagrama acaba de repintarse por cambio de tema. Lo emite el vigilante de
 * `<html data-tema>` y lo escuchan **todos** los bloques de la nota.
 *
 * Se escucha en `document` y no en `editor.view.dom` por lo mismo que en
 * `secreto.ts`: un NodeView se construye dentro de `new EditorView`, cuando
 * `editor.view` todavía no existe.
 */
export const EVENTO_DIAGRAMA_TEMA = 'diagramas-repintar';

/** Milisegundos de calma antes de volcar el código escrito al documento. */
const ESPERA_ESCRITURA = 300;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    diagrama: {
      /** Inserta un bloque de diagrama vacío, listo para escribir. */
      insertarDiagrama: () => ReturnType;
    };
  }
}

/**
 * ¿Toca pintar en oscuro? `TemaService` escribe `data-tema` en <html>, y con
 * 'sistema' lo quita y manda la preferencia del escritorio.
 */
function temaOscuro(): boolean {
  const fijado = document.documentElement.getAttribute('data-tema');
  if (fijado) return fijado === 'oscuro';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Avisa a los diagramas cuando cambia el tema.
 *
 * Hace falta porque Mermaid **incrusta los colores dentro del SVG** al
 * renderizar: un diagrama ya pintado no reacciona a un cambio de tema, se queda
 * con los colores viejos hasta que se vuelve a generar.
 *
 * Vigila las dos vías, porque el tema puede cambiar sin que el usuario toque la
 * app: el atributo (eligió claro/oscuro) y `prefers-color-scheme` (está en
 * 'sistema' y el escritorio ha cambiado solo al anochecer).
 */
let vigilando = false;
function vigilarTema(): void {
  if (vigilando) return;
  vigilando = true;

  const avisar = () => document.dispatchEvent(new CustomEvent(EVENTO_DIAGRAMA_TEMA));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', avisar);
  new MutationObserver(avisar).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-tema'],
  });
}

type Mermaid = Awaited<typeof import('mermaid')>['default'];

let cargando: Promise<Mermaid> | null = null;
/** Tema con el que se configuró Mermaid la última vez (`null` = aún ninguno). */
let temaConfigurado: boolean | null = null;
/** Contador para los `id` que Mermaid exige, únicos por render. */
let secuencia = 0;

/**
 * Mermaid, cargado y configurado para el tema de ahora mismo.
 *
 * Va por `import()` dinámico y no por un import normal a propósito: son unos
 * 500 KB, sobre un bundle que ya ronda 1,2 MB. Cargarlo siempre significaría
 * pagar ese arranque en todas las notas, incluidas las muchas que no tienen ni
 * un diagrama. Así solo lo paga quien inserta uno.
 */
async function mermaidListo(): Promise<Mermaid> {
  cargando ??= import('mermaid').then(async (m) => {
    /* Mermaid mide el texto para dimensionar las cajas. Si mide antes de que la
       fuente esté lista lo hace con la de reserva, y las cajas salen con el
       tamaño equivocado — y ya no se recalculan. */
    await document.fonts?.ready;
    return m.default;
  });

  const mermaid = await cargando;

  const oscuro = temaOscuro();
  if (temaConfigurado !== oscuro) {
    mermaid.initialize({
      startOnLoad: false,
      theme: oscuro ? 'dark' : 'default',
      /* Estas notas se sincronizan y hay bóvedas con colaboradores: un diagrama
         puede venir escrito por otra persona. `strict` desactiva las directivas
         `click` y limpia el HTML de las etiquetas, que dentro de un webview con
         acceso al plugin `shell` no es un detalle estético. */
      securityLevel: 'strict',
      /* Sin esto, un error de sintaxis inyecta el SVG de la bomba directamente
         en `document.body`, fuera del editor. El error lo pintamos nosotros
         dentro del bloque, que es donde el usuario lo puede arreglar. */
      suppressErrorRendering: true,
      fontFamily: 'Roboto, sans-serif',
      /* La opción de más peso de todo el fichero. Con `htmlLabels: true` (el
         valor por defecto) Mermaid mete el texto de cada nodo en un
         `<foreignObject>`, y WebKitGTK —el webview de Tauri en Linux— lo mide
         mal: el texto se sale de la caja o se recorta. Con `false` cae a
         elementos `<text>` nativos: se pierde el formato HTML dentro de las
         etiquetas, y a cambio se ve bien.
         En la raíz y no por diagrama (`flowchart.htmlLabels`, `class.htmlLabels`):
         desde Mermaid 11 esos están deprecados y este los pisa a todos. */
      htmlLabels: false,
    });
    temaConfigurado = oscuro;
  }

  return mermaid;
}

/**
 * Bloque **diagrama**: texto en Mermaid a la izquierda, dibujo a la derecha.
 *
 * El código vive en `attrs.codigo`, no en un nodo de texto, y esa es la
 * decisión que ordena el resto. Como texto del documento, `db::extraer_texto`
 * —que recoge toda clave `text`— metería `graph`, `TD`, `subgraph` y los
 * identificadores sueltos en el índice FTS, y buscar "graph" devolvería todas
 * las notas con diagrama. Desde `attrs` el indexador no lo ve, y Rust extrae
 * aparte solo las etiquetas legibles (ver `db::extraer_etiquetas_mermaid`).
 *
 * Tampoco se guarda nunca el SVG generado: se vuelve a pintar al abrir la nota.
 * Cachearlo ahorraría un render y a cambio convertiría cada retoque del código
 * en un diff de miles de líneas en cada sincronización.
 */
export const Diagrama = Node.create({
  name: 'diagrama',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      /** Hoy solo 'mermaid'. Está para poder añadir otro sin migrar los datos. */
      formato: {
        default: 'mermaid',
        parseHTML: (el) => el.getAttribute('data-formato') ?? 'mermaid',
        renderHTML: (attrs) => ({ 'data-formato': attrs['formato'] }),
      },
      codigo: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-codigo') ?? '',
        renderHTML: (attrs) => ({ 'data-codigo': attrs['codigo'] }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-diagrama]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-diagrama': '' })];
  },

  addCommands() {
    return {
      insertarDiagrama:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { formato: 'mermaid', codigo: '' } }),
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      vigilarTema();

      let actual = node;

      const dom = document.createElement('div');
      dom.className = 'bloque-diagrama';
      dom.contentEditable = 'false';

      // --- barra: qué es esto, y el interruptor de ver/editar ---
      const barra = document.createElement('div');
      barra.className = 'diagrama-barra';

      const rotulo = document.createElement('span');
      rotulo.className = 'diagrama-rotulo';
      rotulo.textContent = 'Mermaid';

      const alternar = document.createElement('button');
      alternar.type = 'button';
      alternar.className = 'diagrama-alternar';
      const iconoAlternar = document.createElement('span');
      iconoAlternar.className = 'material-icons';
      alternar.appendChild(iconoAlternar);
      // No robarle la selección al editor al pulsar.
      alternar.addEventListener('mousedown', (e) => e.preventDefault());

      barra.append(rotulo, alternar);

      // --- código ---
      const area = document.createElement('textarea');
      area.className = 'diagrama-codigo';
      area.spellcheck = false;
      area.value = actual.attrs['codigo'] ?? '';
      area.placeholder = 'graph TD\n  A[Inicio] --> B[Fin]';

      // --- dibujo y error ---
      const vista = document.createElement('div');
      vista.className = 'diagrama-vista';

      const error = document.createElement('p');
      error.className = 'diagrama-error';

      /* Código y dibujo comparten fila mientras quepan y se apilan cuando no
         (`flex-wrap`), que es lo que pasa con la barra lateral abierta. */
      const cuerpo = document.createElement('div');
      cuerpo.className = 'diagrama-cuerpo';
      cuerpo.append(area, vista);

      dom.append(barra, cuerpo, error);

      /* Un diagrama recién insertado se abre en modo código: está vacío, y no
         hay nada que mirar hasta que se escriba algo. */
      let modo: 'codigo' | 'vista' = area.value.trim() ? 'vista' : 'codigo';
      const pintarModo = () => {
        dom.dataset['modo'] = modo;
        iconoAlternar.textContent = modo === 'codigo' ? 'visibility' : 'edit';
        alternar.title = modo === 'codigo' ? 'Ver solo el diagrama' : 'Editar el código';
        alternar.setAttribute('aria-label', alternar.title);
      };

      /*
       * Testigo del render en curso. `mermaid.render` es asíncrono y un NodeView
       * es síncrono: sin esto, dos ediciones seguidas pueden resolverse al revés
       * y dejar el dibujo viejo encima del código nuevo. Cada render se queda
       * con su número y solo pinta si sigue siendo el último.
       */
      let turno = 0;

      const pintar = async () => {
        const mio = ++turno;
        const codigo = (actual.attrs['codigo'] ?? '').trim();

        if (!codigo) {
          vista.replaceChildren();
          error.textContent = '';
          return;
        }

        try {
          const mermaid = await mermaidListo();
          const { svg } = await mermaid.render(`diagrama-${++secuencia}`, codigo);
          if (mio !== turno) return; // llegó tarde: ya hay un render más nuevo
          vista.innerHTML = svg;
          error.textContent = '';
        } catch (e) {
          if (mio !== turno) return;
          /* El dibujo anterior se queda a la vista junto al error. Vaciarlo
             castigaría el estado normal de estar escribiendo: a media línea la
             sintaxis casi nunca es válida, y el bloque estaría parpadeando en
             blanco todo el rato. */
          error.textContent = String(e instanceof Error ? e.message : e)
            .replace(/^Error:\s*/, '')
            .trim();
        }
      };

      // --- escribir ---
      const guardar = (codigo: string) => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos == null) return;
        const tr = editor.view.state.tr.setNodeMarkup(pos, undefined, {
          ...actual.attrs,
          codigo,
        });
        editor.view.dispatch(tr);
      };

      let espera: number | undefined;
      area.addEventListener('input', () => {
        window.clearTimeout(espera);
        // Se espera a que pare de escribir: volcar en cada tecla llenaría el
        // historial de deshacer de pasos de un carácter.
        espera = window.setTimeout(() => guardar(area.value), ESPERA_ESCRITURA);
      });

      area.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        /* En Mermaid la sangría separa un `subgraph` de su contenido, así que
           el tabulador tiene que sangrar y no saltar al siguiente control. */
        e.preventDefault();
        const { selectionStart: ini, selectionEnd: fin, value } = area;
        area.value = `${value.slice(0, ini)}  ${value.slice(fin)}`;
        area.selectionStart = area.selectionEnd = ini + 2;
        area.dispatchEvent(new Event('input'));
      });

      // Al salir del campo se vuelca ya, sin esperar: si no, cerrar la nota
      // justo después de escribir perdería las últimas letras.
      area.addEventListener('blur', () => {
        window.clearTimeout(espera);
        if (area.value !== actual.attrs['codigo']) guardar(area.value);
      });

      alternar.addEventListener('click', () => {
        modo = modo === 'codigo' ? 'vista' : 'codigo';
        pintarModo();
        if (modo === 'codigo') area.focus();
      });

      // Doble clic en el dibujo: el camino corto para corregir lo que se ve mal.
      vista.addEventListener('dblclick', () => {
        if (modo === 'vista') {
          modo = 'codigo';
          pintarModo();
          area.focus();
        }
      });

      const alCambiarTema = () => void pintar();
      document.addEventListener(EVENTO_DIAGRAMA_TEMA, alCambiarTema);

      pintarModo();
      void pintar();

      return {
        dom,
        /* `atom`: ProseMirror no gestiona nada de aquí dentro, y todo lo que
           cambia (el SVG, el texto del error, el textarea) lo movemos nosotros. */
        ignoreMutation: () => true,
        /* Las pulsaciones dentro del código y de la barra son nuestras. Sin
           esto, ProseMirror las interpretaría como edición del documento y no
           se podría ni escribir en el campo. */
        stopEvent: (e) => {
          const destino = e.target as globalThis.Node | null;
          return !!destino && (area.contains(destino) || barra.contains(destino));
        },
        update: (nuevo) => {
          if (nuevo.type !== actual.type) return false;
          actual = nuevo;
          const codigo = nuevo.attrs['codigo'] ?? '';
          // Solo si de verdad cambió: asignar `value` mientras se escribe
          // mandaría el cursor al final en cada volcado.
          if (codigo !== area.value) area.value = codigo;
          void pintar();
          return true;
        },
        destroy: () => {
          window.clearTimeout(espera);
          document.removeEventListener(EVENTO_DIAGRAMA_TEMA, alCambiarTema);
          // Que un render en vuelo no escriba sobre un nodo ya destruido.
          turno++;
        },
      };
    };
  },
});
