import { OverlayModule } from '@angular/cdk/overlay';
import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';

import { srcIcono } from '../core/asset-path';
import { bgTag, fgTag } from '../core/color-etiqueta';
import { BovedasService } from '../core/bovedas.service';
import { ListaDocumentosService } from '../core/lista-documentos.service';
import { SincroService } from '../core/sincro.service';
import { POSICIONES_MENU } from '../shared/posiciones-menu';

/** Un trozo del fragmento de búsqueda, resaltado o no. */
interface Parte {
  t: string;
  hl: boolean;
}

/**
 * Barra lateral: bóveda abierta, buscador, filtro por etiquetas y la lista de
 * notas.
 *
 * Lo que **pinta** lo saca de los servicios (`ListaDocumentosService` para la
 * lista, `BovedasService` para el cuaderno). Lo que **cambia el documento
 * abierto** —abrir, crear, borrar, cambiar de bóveda— sale por eventos: eso lo
 * lleva la app, que es quien sabe vaciar el guardado pendiente antes.
 */
@Component({
  selector: 'app-barra-lateral',
  standalone: true,
  imports: [FormsModule, OverlayModule, MatButtonModule, MatIconModule, MatListModule],
  templateUrl: './barra-lateral.html',
  styleUrl: './barra-lateral.scss',
  host: {
    role: 'complementary',
    // El estado plegado llega de la app (manda el ancho de la rejilla), pero se
    // refleja aquí para que el CSS de dentro pueda mirarlo: `.colapsada .x`
    // desde fuera no alcanzaría a un componente encapsulado.
    '[class.colapsada]': 'colapsada()',
  },
})
export class BarraLateral {
  protected readonly lista = inject(ListaDocumentosService);
  protected readonly bovedas = inject(BovedasService);
  protected readonly sincro = inject(SincroService);

  /** Plegada a solo iconos. */
  readonly colapsada = input(false);
  /** Id de la nota abierta, para marcarla en la lista. */
  readonly seleccionado = input<string | null>(null);
  /** Hay un cambio de bóveda en marcha: el selector no acepta otro. */
  readonly cambiandoBoveda = input(false);

  readonly alternarColapsada = output<void>();
  readonly abrirDoc = output<string>();
  readonly nuevoDoc = output<void>();
  readonly eliminarDoc = output<string>();
  readonly abrirConfiguracion = output<void>();
  readonly cambiarBoveda = output<string>();
  readonly crearBoveda = output<string>();

  /** Selector de bóveda (solo interfaz: el cambio lo hace la app). */
  protected readonly menuBovedas = signal(false);
  protected readonly nombreBovedaNueva = signal('');
  protected readonly posicionesMenu = POSICIONES_MENU;

  protected readonly bgTag = bgTag;
  protected readonly fgTag = fgTag;

  /** URL de la imagen de un icono, o null si es un emoji. */
  protected imagenIcono(icono: string | null | undefined): string | null {
    return srcIcono(icono);
  }

  protected elegirBoveda(id: string): void {
    this.menuBovedas.set(false);
    this.cambiarBoveda.emit(id);
  }

  protected pedirBovedaNueva(): void {
    const nombre = this.nombreBovedaNueva().trim();
    if (!nombre) return;
    this.menuBovedas.set(false);
    this.nombreBovedaNueva.set('');
    this.crearBoveda.emit(nombre);
  }

  /** El clic es sobre la fila: sin frenarlo, borrar abriría además la nota. */
  protected pedirBorrado(id: string, ev: Event): void {
    ev.stopPropagation();
    this.eliminarDoc.emit(id);
  }

  /**
   * Parte el fragmento en segmentos, marcando (hl) los términos encontrados
   * (delimitados por U+0002/U+0003), para resaltarlos sin usar innerHTML.
   */
  protected partesFragmento(fragmento: string): Parte[] {
    const partes: Parte[] = [];
    let buffer = '';
    let hl = false;
    for (const ch of fragmento) {
      const code = ch.charCodeAt(0);
      if (code === 2 || code === 3) {
        // 2 = U+0002 (inicio de término encontrado), 3 = U+0003 (fin)
        if (buffer) partes.push({ t: buffer, hl });
        buffer = '';
        hl = code === 2;
      } else {
        buffer += ch;
      }
    }
    if (buffer) partes.push({ t: buffer, hl });
    return partes;
  }
}
