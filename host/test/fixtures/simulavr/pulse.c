// Exact six-cycle loop: high for two cycles, low for four cycles.
#include <avr/io.h>
int main(void) {
    asm volatile("sbi %0,0\n1: sbi %1,0\ncbi %1,0\nrjmp 1b"
                 : : "I" (_SFR_IO_ADDR(DDRA)), "I" (_SFR_IO_ADDR(PORTA)));
    __builtin_unreachable();
}
