import { OverlayModule } from '@angular/cdk/overlay';
import { Component, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { DragScrollDirective } from '../../shared/drag-scroll';
import { POSICIONES_MENU } from '../../shared/posiciones-menu';
import { EditorComponent } from '../editor';

/**
 * Barra de herramientas de la nota (negrita, títulos, listas, colores…).
 *
 * No sabe nada de documentos ni de guardado: recibe el editor y le da órdenes.
 * Todo lo que guarda es **qué desplegable está abierto**, que no le importa a
 * nadie más — por eso vive aquí y no en el componente raíz.
 *
 * El editor entra como input y no por inyección a propósito: se pinta ANTES que
 * él en la plantilla de la app, así que no hay un padre común del que sacarlo.
 */
@Component({
  selector: 'app-barra-herramientas',
  standalone: true,
  imports: [FormsModule, OverlayModule, DragScrollDirective],
  templateUrl: './barra-herramientas.html',
  styleUrl: './barra-herramientas.scss',
})
export class BarraHerramientas {
  /** El editor sobre el que actúan los botones. */
  readonly ed = input.required<EditorComponent>();

  /** Desplegables de la barra. */
  protected readonly menuTitulos = signal(false);
  protected readonly menuListas = signal(false);
  protected readonly menuAlinear = signal(false);
  protected readonly menuColorTexto = signal(false);
  protected readonly menuResaltado = signal(false);

  /** Popover de enlace: abierto y URL que se está escribiendo. */
  protected readonly enlaceAbierto = signal(false);
  protected readonly enlaceUrl = signal('');

  /** Paletas para color de texto y resaltado. */
  protected readonly coloresTexto = [
    '#000000', '#495057', '#e03131', '#e8590c', '#f08c00', '#2f9e44',
    '#0ca678', '#1971c2', '#4263eb', '#7048e8', '#ae3ec9', '#c2255c',
  ];
  protected readonly coloresResaltado = [
    '#ffec99', '#ffd8a8', '#ffc9c9', '#eebefa', '#d0bfff', '#bac8ff',
    '#a5d8ff', '#99e9f2', '#c3fae8', '#b2f2bb', '#d8f5a2', '#dee2e6',
  ];

  protected readonly posicionesMenu = POSICIONES_MENU;

  /** Abre el popover con la URL que ya tuviera el enlace bajo el cursor. */
  protected abrirEnlace(urlActual: string): void {
    this.enlaceUrl.set(urlActual);
    this.enlaceAbierto.set(true);
    setTimeout(() => document.querySelector<HTMLInputElement>('.enlace-input')?.focus(), 0);
  }

  /**
   * Cierra todo lo que estuviera desplegado.
   *
   * La llama la app al cambiar de nota: la barra no se destruye entre una y
   * otra, y un menú abierto sobre un documento que ya no está actuaría sobre el
   * nuevo.
   */
  cerrarMenus(): void {
    this.menuTitulos.set(false);
    this.menuListas.set(false);
    this.menuAlinear.set(false);
    this.menuColorTexto.set(false);
    this.menuResaltado.set(false);
    this.enlaceAbierto.set(false);
  }
}
