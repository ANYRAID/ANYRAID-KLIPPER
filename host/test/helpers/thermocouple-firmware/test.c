// Execute the real thermocouple handlers with deterministic SPI/timer stubs.
#include <assert.h>
#include <stdint.h>
#include <stddef.h>
#define container_of(ptr, type, member) \
    ((type *)((char *)(ptr)-offsetof(type, member)))
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define __SCHED_H
#define __COMMAND_H
#define DECL_COMMAND(func, format)
#define DECL_ENUMERATION(name, label, value)
#define DECL_CONSTANT(name, value)
#define DECL_TASK(func)
#define shutdown(message) abort()
struct timer { uint_fast8_t (*func)(struct timer *); uint32_t waketime; };
struct task_wake { uint8_t wake; };
enum { SF_RESCHEDULE=1 };
uint8_t test_irq=1;
static int stopped;
static uint32_t reported;
static uint8_t reported_fault;
static uint32_t spi_word;
static uint8_t spi_fault;
static void sched_add_timer(struct timer *t) { (void)t; }
static void sched_del_timer(struct timer *t) { (void)t; }
static void sched_wake_task(struct task_wake *w) { w->wake=1; }
static uint8_t sched_check_wake(struct task_wake *w) { return w->wake; }
static void try_shutdown(const char *message) { (void)message; stopped++; }
static void capture(uint8_t oid, uint32_t clock, uint32_t value, uint8_t fault)
{ (void)oid; (void)clock; reported=value; reported_fault=fault; }
#define sendf(format, ...) capture(__VA_ARGS__)
#include "../../../../src/thermocouple.c"
static struct thermocouple_spi object;
void *oid_alloc(uint8_t oid, void *type, uint16_t size)
{ (void)oid; (void)type; assert(size==sizeof(object));
    memset(&object,0,size); return &object; }
void *oid_lookup(uint8_t oid, void *type)
{ (void)oid; (void)type; return &object; }
void *oid_next(uint8_t *oid, void *type)
{ (void)type; if(*oid==255){*oid=0;return &object;}return NULL; }
struct spidev_s *spidev_oid_lookup(uint8_t oid) { (void)oid; return NULL; }
void spidev_transfer(struct spidev_s *spi, uint8_t receive, uint8_t length
                     , uint8_t *data)
{ (void)spi; (void)receive;
    if(object.chip_type==TS_CHIP_MAX31856) {
        if(length==2) { assert(data[0]==0x0f);data[1]=spi_fault;return; }
        assert(length==4 && data[0]==0x0c);
    }
    for(int i=0;i<length;i++)data[i]=spi_word>>(8*(length-i-1)); }
static uint32_t word(int code) { return ((uint32_t)code&0x3fff)<<18; }
static uint32_t word56(int code) { return ((uint32_t)code&0x7ffff)<<5; }
int main(void)
{
    uint32_t config[]={0,1,TS_CHIP_MAX31855};
    command_config_thermocouple(config);
    uint32_t query[]={0,100,300,word(-40),word(400)+0x3ffff,3};
    command_query_thermocouple(query);
    for(int code=-8192;code<8192;code++)for(int cold=0;cold<2;cold++) {
        spi_word=word(code)+(cold?0xfff0:0); stopped=0; object.invalid_count=0;
        for(int i=0;i<3;i++)thermocouple_handle_max31855(&object,400,0);
        assert(reported==spi_word && reported_fault==0);
        assert(stopped==(code< -40||code>400));
    }
    for(int bit=0;bit<32;bit++)if(bit<4||bit==16||bit==17) {
        spi_word=1u<<bit;stopped=0;object.invalid_count=0;
        for(int i=0;i<3;i++)thermocouple_handle_max31855(&object,400,0);
        assert(reported_fault && stopped==1);
    }
    config[2]=TS_CHIP_MAX31856;command_config_thermocouple(config);
    query[3]=word56(-12800);query[4]=word56(38400)+31;
    command_query_thermocouple(query);
    for(int code=-262144;code<262144;code++)for(int low=0;low<2;low++) {
        spi_word=word56(code)+(low?31:0);stopped=0;
        object.invalid_count=0;
        for(int i=0;i<3;i++)thermocouple_handle_max31856(&object,400,0);
        assert(reported==spi_word && reported_fault==0);
        assert(stopped==(code< -12800||code>38400));
    }
    for(int fault=1;fault<256;fault++) {
        spi_fault=fault;spi_word=word56(3200);stopped=0;
        object.invalid_count=0;
        for(int i=0;i<2;i++)thermocouple_handle_max31856(&object,400,0);
        assert(reported_fault==fault && stopped==0);
        thermocouple_handle_max31856(&object,400,0);assert(stopped==1);
    }
    // A valid report resets the consecutive-invalid counter.
    spi_fault=1;stopped=0;object.invalid_count=0;
    for(int i=0;i<2;i++)thermocouple_handle_max31856(&object,400,0);
    spi_fault=0;thermocouple_handle_max31856(&object,400,0);
    assert(object.invalid_count==0 && stopped==0);
    spi_word=word56(-12801);
    for(int i=0;i<2;i++)thermocouple_handle_max31856(&object,400,0);
    assert(stopped==0);
    thermocouple_handle_max31856(&object,400,0);assert(stopped==1);
    assert(max31856_out_of_range(0x1000000,0,0x7fffff));
    // MAX6675 retains unsigned comparison and its existing fault encoding.
    object.chip_type=TS_CHIP_MAX6675;object.min_value=0;object.max_value=3201;
    for(int code=0;code<4096;code++) {
        spi_word=code*8;stopped=0;object.invalid_count=0;
        for(int i=0;i<3;i++)thermocouple_handle_max6675(&object,400,0);
        assert(stopped==(code>400));}
    puts("thermocouple firmware: passed");return 0;
}
