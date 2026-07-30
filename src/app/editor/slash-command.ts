import { Editor, Extension, Range } from '@tiptap/core';
import Suggestion, {
  SuggestionKeyDownProps,
  SuggestionProps,
} from '@tiptap/suggestion';

/** Una entrada del menú "/". `command` inserta el bloque y borra el "/query". */
export interface SlashItem {
  title: string;
  subtitle: string;
  icon: string;
  keywords?: string[];
  /** Inserta un bloque NUEVO en vez de convertir el actual (divisor, imagen):
   *  el menú del bloque ⠿ las deja fuera, porque ahí son "convertir en…". */
  insercion?: boolean;
  command: (p: { editor: Editor; range: Range }) => void;
}

/**
 * Evento con el que la entrada "Imagen" pide abrir el selector de ficheros.
 * Se avisa por el DOM porque elegir la imagen es cosa del componente (diálogo
 * nativo de Tauri y pantalla de edición), no de una extensión de Tiptap. Lo
 * escucha `editor.ts` sobre el DOM del editor.
 */
export const EVENTO_IMAGEN = 'pedir-imagen';
/** Aviso para abrir el diálogo del bloque cifrado (ver `editor/secreto.ts`). */
export const EVENTO_SECRETO = 'pedir-secreto';

/** Lo que el componente debe implementar para pintar el popup. */
export type SlashRender = () => {
  onStart?: (props: SuggestionProps<SlashItem, SlashItem>) => void;
  onUpdate?: (props: SuggestionProps<SlashItem, SlashItem>) => void;
  onExit?: (props: SuggestionProps<SlashItem, SlashItem>) => void;
  onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
};

export const SLASH_ITEMS: SlashItem[] = [
  {
    title: 'Texto', subtitle: 'Párrafo normal', icon: '¶',
    keywords: ['texto', 'parrafo', 'paragraph', 'p'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: 'Título 1', subtitle: 'Encabezado grande', icon: 'H1',
    keywords: ['titulo', 'heading', 'h1'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
  },
  {
    title: 'Título 2', subtitle: 'Encabezado mediano', icon: 'H2',
    keywords: ['titulo', 'heading', 'h2'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
  },
  {
    title: 'Título 3', subtitle: 'Encabezado pequeño', icon: 'H3',
    keywords: ['titulo', 'heading', 'h3'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
  },
  {
    title: 'Lista con viñetas', subtitle: 'Lista simple', icon: '•',
    keywords: ['lista', 'bullet', 'ul', 'vinetas'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).alternarLista('vinetas').run(),
  },
  {
    title: 'Lista numerada', subtitle: 'Lista ordenada', icon: '1.',
    keywords: ['lista', 'ordenada', 'numerada', 'ol'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).alternarLista('numerada').run(),
  },
  {
    title: 'Lista de tareas', subtitle: 'Casillas para marcar', icon: '☑',
    keywords: ['tarea', 'todo', 'check', 'task', 'casilla'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).alternarLista('tarea').run(),
  },
  {
    title: 'Cita', subtitle: 'Bloque citado', icon: '❝',
    keywords: ['cita', 'quote', 'blockquote'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Código', subtitle: 'Bloque de código', icon: '</>',
    keywords: ['codigo', 'code', 'pre'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'Divisor', subtitle: 'Línea horizontal', icon: '―',
    keywords: ['divisor', 'separador', 'hr', 'rule', 'linea'],
    insercion: true,
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: 'Imagen', subtitle: 'Elegir un fichero del equipo', icon: '🖼',
    keywords: ['imagen', 'image', 'foto', 'photo', 'img', 'captura', 'picture'],
    insercion: true,
    command: ({ editor, range }) => {
      // Primero se quita el "/imagen" escrito; el resto (elegir el fichero y
      // editarlo) lo hace el componente al recibir el aviso.
      editor.chain().focus().deleteRange(range).run();
      editor.view.dom.dispatchEvent(new CustomEvent(EVENTO_IMAGEN, { bubbles: true }));
    },
  },
  {
    title: 'Bloque cifrado',
    subtitle: 'Contraseñas, cadenas de conexión…',
    icon: '🔑',
    keywords: ['cifrado', 'secreto', 'password', 'contraseña', 'clave', 'credencial', 'token'],
    insercion: true,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      // El valor lo pide un diálogo del componente y lo cifra Rust: el texto en
      // claro no puede pasar por el documento ni un instante, porque el
      // autoguardado lo escribiría en disco y en un commit.
      editor.view.dom.dispatchEvent(
        new CustomEvent(EVENTO_SECRETO, {
          bubbles: true,
          detail: { pos: null, etiqueta: '', datos: '' },
        }),
      );
    },
  },
];

function filtrar(query: string): SlashItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (it) => it.title.toLowerCase().includes(q) || it.keywords?.some((k) => k.includes(q)),
  );
}

/** Extensión Tiptap del menú "/". El pintado del popup lo aporta `render`. */
export function createSlashCommand(render: SlashRender): Extension {
  return Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          char: '/',
          startOfLine: false,
          items: ({ query }) => filtrar(query),
          command: ({ editor, range, props }) => props.command({ editor, range }),
          render,
        }),
      ];
    },
  });
}
