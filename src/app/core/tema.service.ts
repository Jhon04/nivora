import { Injectable, inject, signal } from '@angular/core';

import { PreferenciasService, Tema } from './preferencias.service';

export type { Tema };

/**
 * Tema claro/oscuro. Solo escribe `data-tema` en <html>; el color real lo
 * resuelve styles.scss traduciendo ese atributo a `color-scheme`, que es de
 * donde cuelgan los `light-dark()` del tema de Material y de la app.
 *
 * Con 'sistema' se quita el atributo y manda `prefers-color-scheme`.
 */
@Injectable({ providedIn: 'root' })
export class TemaService {
  private readonly prefs = inject(PreferenciasService);

  readonly tema = signal<Tema>(this.prefs.obtener().tema);

  constructor() {
    // Se aplica aquí y no en un effect() para que el tema ya esté puesto en el
    // primer pintado: con un effect habría un parpadeo claro al arrancar.
    this.aplicar(this.tema());
  }

  fijar(tema: Tema): void {
    this.tema.set(tema);
    this.aplicar(tema);
    this.prefs.fijar('tema', tema);
  }

  private aplicar(tema: Tema): void {
    const html = document.documentElement;
    if (tema === 'sistema') {
      html.removeAttribute('data-tema');
    } else {
      html.setAttribute('data-tema', tema);
    }
  }
}
