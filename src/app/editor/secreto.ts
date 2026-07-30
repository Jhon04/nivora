import { Node, mergeAttributes } from '@tiptap/core';

import { EVENTO_SECRETO, EVENTO_SECRETO_ABIERTO, EVENTO_SECRETO_ABRIR } from './slash-command';

/** Detalle del evento: qué nodo se está editando (o ninguno, si es nuevo). */
export interface PeticionSecreto {
  /** Posición del nodo en el documento, o `null` si se va a crear uno. */
  pos: number | null;
  etiqueta: string;
  datos: string;
}

/** Lo que la app necesita resolver un revelado. */
export type Descifrar = (datos: string) => Promise<string>;

/** Lo que `editor.ts` deja en `editor.storage['secreto']` para el NodeView. */
export interface AlmacenSecreto {
  descifrar?: Descifrar;
  /** ¿Está la clave maestra en memoria ahora mismo? */
  desbloqueado?: () => boolean;
}

/**
 * Máscara de longitud **fija**.
 *
 * No se pintan tantos puntos como caracteres tenga el valor: la longitud de una
 * contraseña es información, y enseñarla a quien mira la pantalla estrecha la
 * búsqueda sin que el dueño se entere de que lo ha contado.
 */
const OCULTO = '••••••••••';

/** Segundos que un valor revelado sigue a la vista. Coincide con la animación. */
const SEGUNDOS_VISIBLE = 20;

/**
 * Bloque **secreto**: guarda un valor cifrado (contraseñas, cadenas de
 * conexión, credenciales) dentro de una nota normal.
 *
 * Es un `atom` a propósito, y esa es la decisión que sostiene todo lo demás: el
 * texto en claro **nunca entra en el documento**. Si el valor fuera texto
 * editable y se cifrara "al guardar", el autoguardado ya lo habría escrito en
 * claro en disco y en un commit — y git no olvida. Aquí el nodo solo tiene el
 * resultado del cifrado, que hace Rust.
 *
 * Como el valor viaja en `attrs` y no en un nodo de texto, el indexador de
 * búsqueda (`db::extraer_texto`, que recoge las claves `text`) no lo ve: el
 * índice FTS nunca contiene el secreto. La etiqueta sí es texto normal, para
 * poder buscarla y saber qué es sin abrirlo.
 */
export const Secreto = Node.create({
  name: 'secreto',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      etiqueta: { default: '' },
      /** Valor cifrado, con su prefijo de versión (`v1.…`). */
      datos: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-secreto]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-secreto': '' })];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      /*
       * Cuatro estados, y el `data-estado` del contenedor los pinta todos desde
       * el SCSS. Tenerlo en un único atributo evita el error clásico de ir
       * añadiendo y quitando clases sueltas y acabar en combinaciones que no
       * existen (revelado *y* bloqueado a la vez).
       */
      type Estado = 'oculto' | 'visible' | 'bloqueado' | 'error';

      const dom = document.createElement('div');
      dom.className = 'bloque-secreto';
      dom.contentEditable = 'false';

      /* Una sola fila, con forma de `mat-form-field` outlined: la etiqueta
         flota **sobre el borde superior** y lleva el fondo del tema para tapar
         el trozo de línea que si no le cruzaría el texto. Por eso el campo no
         puede tener relleno propio: el fondo del rótulo tiene que ser el mismo
         que hay detrás, o se vería el parche. */
      const etiqueta = document.createElement('span');
      etiqueta.className = 'secreto-etiqueta';
      etiqueta.textContent = node.attrs['etiqueta'] || 'Secreto';

      const campo = document.createElement('div');
      campo.className = 'secreto-campo';

      const sello = document.createElement('span');
      sello.className = 'secreto-sello';
      const icono = document.createElement('span');
      icono.className = 'material-icons';
      icono.textContent = 'key';
      sello.appendChild(icono);
      campo.appendChild(sello);

      const valor = document.createElement('span');
      valor.className = 'secreto-valor';
      // Enmascarado siempre al pintar: abrir una nota no puede destapar
      // credenciales por su cuenta (una captura, alguien detrás, un proyector).
      valor.textContent = OCULTO;

      const acciones = document.createElement('span');
      acciones.className = 'secreto-acciones';
      campo.appendChild(valor);

      // Se vacía sola al cambiar de estado: un mensaje de error que sobrevive a
      // la acción siguiente miente sobre lo que está pasando.
      const nota = document.createElement('p');
      nota.className = 'secreto-nota';

      /*
       * La cuenta atrás del revelado. Es una animación de CSS y no un
       * `setInterval`: el navegador la para solo si la pestaña se oculta, no
       * hay que limpiarla al destruir el nodo, y no repinta 20 veces por
       * secreto. Reiniciarla es quitar y volver a poner el elemento.
       */
      const barra = document.createElement('span');
      barra.className = 'secreto-barra';

      const boton = (icono: string, titulo: string, clase = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = titulo;
        b.setAttribute('aria-label', titulo);
        if (clase) b.className = clase;
        b.contentEditable = 'false';
        const i = document.createElement('span');
        i.className = 'material-icons';
        i.textContent = icono;
        b.appendChild(i);
        // No robarle la selección al editor al pulsar.
        b.addEventListener('mousedown', (e) => e.preventDefault());
        return { b, i };
      };

      /* Los tres botones se crean antes que `pintar`, que necesita el del ojo
         para cambiarle el icono. Sus escuchas se enganchan más abajo, cuando ya
         existen las funciones a las que llaman. */
      const { b: copiar, i: iconoCopiar } = boton(
        'content_copy',
        'Copiar',
        'secreto-principal secreto-requiere-clave',
      );
      const { b: ojo, i: iconoOjo } = boton('visibility', 'Mostrar', 'secreto-requiere-clave');
      const { b: editar } = boton('edit', 'Cambiar el valor');

      const almacen = (): AlmacenSecreto =>
        (editor.storage as unknown as Record<string, AlmacenSecreto>)['secreto'] ?? {};

      const descifrar = (): Promise<string> => {
        const fn = almacen().descifrar;
        if (!fn) return Promise.reject(new Error('secretos no disponibles'));
        return fn(node.attrs['datos']);
      };

      let temporizador: number | undefined;

      const pintar = (estado: Estado, mensaje = '') => {
        dom.dataset['estado'] = estado;
        nota.textContent = mensaje;
        iconoOjo.textContent = estado === 'visible' ? 'visibility_off' : 'visibility';
        ojo.title = estado === 'visible' ? 'Ocultar' : 'Mostrar';

        barra.remove();
        if (estado === 'visible') campo.appendChild(barra); // reinicia la animación
      };

      const ocultar = () => {
        window.clearTimeout(temporizador);
        valor.textContent = OCULTO;
        pintar('oculto');
      };

      /**
       * Traduce un fallo del descifrado a algo que se pueda hacer.
       *
       * El caso corriente no es un error: es que la clave se cerró sola a los 5
       * minutos. Antes eso era un icono de candado parpadeando segundo y medio,
       * que dejaba al usuario sin saber qué hacer y sin salida desde el propio
       * bloque.
       */
      const fallo = (e: unknown) => {
        if (almacen().desbloqueado?.() === false) {
          pintar('bloqueado', 'La clave maestra está cerrada.');
          return;
        }
        pintar('error', String(e).replace(/^Error:\s*/, ''));
      };

      // --- revelar ---
      ojo.addEventListener('click', () => {
        if (dom.dataset['estado'] === 'visible') {
          ocultar();
          return;
        }
        void descifrar()
          .then((claro) => {
            valor.textContent = claro;
            pintar('visible');
            // Se vuelve a tapar solo: lo normal es mirarlo y seguir a lo tuyo.
            temporizador = window.setTimeout(ocultar, SEGUNDOS_VISIBLE * 1000);
          })
          .catch(fallo);
      });

      // --- copiar ---
      copiar.addEventListener('click', () => {
        void descifrar()
          .then(async (claro) => {
            // Copiar sin enseñarlo es el uso habitual: pegar una contraseña.
            await navigator.clipboard.writeText(claro);
            iconoCopiar.textContent = 'check';
            copiar.classList.add('hecho');
            window.setTimeout(() => {
              iconoCopiar.textContent = 'content_copy';
              copiar.classList.remove('hecho');
            }, 1500);
          })
          .catch(fallo);
      });

      // --- editar ---
      const pedirEdicion = () => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        editor.view.dom.dispatchEvent(
          new CustomEvent<PeticionSecreto>(EVENTO_SECRETO, {
            bubbles: true,
            detail: {
              pos: pos ?? null,
              etiqueta: node.attrs['etiqueta'] ?? '',
              datos: node.attrs['datos'] ?? '',
            },
          }),
        );
      };
      editar.addEventListener('click', pedirEdicion);
      dom.addEventListener('dblclick', pedirEdicion);

      // --- desbloquear (solo visible en el estado `bloqueado`) ---
      const abrir = document.createElement('button');
      abrir.type = 'button';
      abrir.className = 'secreto-abrir';
      abrir.textContent = 'Desbloquear';
      abrir.contentEditable = 'false';
      abrir.addEventListener('mousedown', (e) => e.preventDefault());
      abrir.addEventListener('click', () =>
        editor.view.dom.dispatchEvent(new CustomEvent(EVENTO_SECRETO_ABRIR, { bubbles: true })),
      );

      /* Cuando la bóveda se abre, todos los bloques de la nota vuelven a su
         estado normal a la vez. Sin esto, cada uno se quedaría diciendo
         «Bloqueado» hasta que lo tocaras.

         Se escucha en `document` y no en `editor.view.dom` porque esto corre
         DENTRO de `new EditorView`: la vista aún no está asignada y pedirla
         aquí revienta al abrir cualquier nota con un secreto. El evento sube
         hasta aquí solo. */
      const alAbrirse = () => {
        if (dom.dataset['estado'] === 'bloqueado') ocultar();
      };
      document.addEventListener(EVENTO_SECRETO_ABIERTO, alAbrirse);

      acciones.append(copiar, ojo, editar);
      // «Desbloquear» va fuera de `.secreto-acciones`: no es uno de los iconos, y
      // ahí dentro el selector `.secreto-acciones button` le ganaba en
      // especificidad y le imponía su aspecto y su `display`.
      campo.append(acciones, abrir, barra);
      // La etiqueta va en la raíz, no dentro del campo: el campo recorta
      // (`overflow: hidden`) para que la cuenta atrás no se salga de las
      // esquinas redondeadas, y ahí dentro el rótulo no podría asomar arriba.
      dom.append(etiqueta, campo, nota);
      pintar('oculto');

      return {
        dom,
        // `atom`: ProseMirror no gestiona nada dentro, así que se ignoran las
        // mutaciones del DOM propio (revelar, tapar, iconos de aviso).
        ignoreMutation: () => true,
        destroy: () => {
          window.clearTimeout(temporizador);
          document.removeEventListener(EVENTO_SECRETO_ABIERTO, alAbrirse);
        },
      };
    };
  },
});
