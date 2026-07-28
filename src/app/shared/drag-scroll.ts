import { Directive, ElementRef, inject, OnDestroy } from '@angular/core';

/**
 * Desplaza horizontalmente un contenedor con scroll: arrastrando con el ratón
 * (click + arrastrar) y con la rueda vertical → scroll horizontal. Pensado para
 * la barra de herramientas: cuando no caben todos los botones, en vez de saltar
 * a otra fila se quedan en una sola y se accede a los ocultos desplazando.
 *
 * No interfiere con los clics de los botones: solo desplaza si hay arrastre real
 * (> 5px) y suprime el clic sintético que seguiría a un arrastre.
 */
@Directive({
  selector: '[appDragScroll]',
  standalone: true,
})
export class DragScrollDirective implements OnDestroy {
  private readonly el: HTMLElement = inject(ElementRef).nativeElement;

  private inicioX = 0;
  private inicioScroll = 0;
  private pulsado = false;
  private arrastrado = false;
  private suprimirClic = false;

  constructor() {
    this.el.addEventListener('mousedown', this.onDown);
    this.el.addEventListener('wheel', this.onWheel, { passive: false });
    this.el.addEventListener('click', this.onClickCapture, true);
  }

  private get hayDesborde(): boolean {
    return this.el.scrollWidth > this.el.clientWidth + 1;
  }

  private onDown = (e: MouseEvent): void => {
    if (e.button !== 0 || !this.hayDesborde) return;
    this.pulsado = true;
    this.arrastrado = false;
    this.inicioX = e.clientX;
    this.inicioScroll = this.el.scrollLeft;
    document.addEventListener('mousemove', this.onMove, true);
    document.addEventListener('mouseup', this.onUp, true);
  };

  private onMove = (e: MouseEvent): void => {
    if (!this.pulsado) return;
    const dx = e.clientX - this.inicioX;
    if (!this.arrastrado && Math.abs(dx) < 5) return;
    this.arrastrado = true;
    e.preventDefault();
    this.el.classList.add('arrastrando');
    this.el.scrollLeft = this.inicioScroll - dx;
  };

  private onUp = (): void => {
    document.removeEventListener('mousemove', this.onMove, true);
    document.removeEventListener('mouseup', this.onUp, true);
    this.pulsado = false;
    this.el.classList.remove('arrastrando');
    if (this.arrastrado) {
      // Evita que el arrastre dispare el clic de un botón (el clic va justo
      // después del mouseup; el setTimeout limpia el flag tras ese clic).
      this.suprimirClic = true;
      setTimeout(() => (this.suprimirClic = false), 0);
    }
  };

  private onClickCapture = (e: MouseEvent): void => {
    if (this.suprimirClic) {
      e.stopPropagation();
      e.preventDefault();
      this.suprimirClic = false;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    // Rueda vertical del ratón → scroll horizontal cuando hay desbordamiento.
    if (e.deltaY === 0 || !this.hayDesborde) return;
    e.preventDefault();
    this.el.scrollLeft += e.deltaY;
  };

  ngOnDestroy(): void {
    this.el.removeEventListener('mousedown', this.onDown);
    this.el.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('click', this.onClickCapture, true);
    document.removeEventListener('mousemove', this.onMove, true);
    document.removeEventListener('mouseup', this.onUp, true);
  }
}
