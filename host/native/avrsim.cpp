// Native instruction engine; Node owns CLI, pacing and terminal lifecycle.
// UART sampling derived from the former scripts/avrsim.py.
// Copyright (C) 2015-2018 Kevin O'Connor. GPL-3.0-or-later.
#include <vector>
#include <map>
#include <deque>
#include <iostream>
#include <stdexcept>
#include <cstdint>
#include <unistd.h>
#include <cerrno>
#include <limits>
#include <fstream>
#include <sstream>
#include "traceval.h"
#include "avrdevice.h"
#include "avrfactory.h"
#include "avrerror.h"
#include "systemclock.h"
#include "simulationmember.h"
#include "pin.h"
#include "net.h"
static const size_t LIMIT = 65536;
static bool transfer(int fd, void *data, size_t size, bool writing) {
    auto *p = static_cast<unsigned char *>(data);const size_t original=size;
    while(size) {
        ssize_t n = writing ? write(fd,p,size) : read(fd,p,size);
        if(n<0 && errno==EINTR) continue;
        if(n<=0) { if(!writing && n==0 && size==original) return false; throw std::runtime_error("pipe failed"); }
        p+=n;size-=n;
    }
    return true;
}
static uint32_t get32(const unsigned char *p) {
    return uint32_t(p[0]) | uint32_t(p[1])<<8 | uint32_t(p[2])<<16 | uint32_t(p[3])<<24;
}
class Receive : public Pin, public SimulationMember {
    SystemClockOffset delay;int pos=-1;unsigned value=0;bool high=false;
 public:
    std::vector<unsigned char> bytes;
    explicit Receive(unsigned baud):delay(1000000000/baud){}
    void SetInState(const Pin &p) override {
        Pin::SetInState(p);high=p.outState==HIGH;
        if(pos<0 && p.outState==LOW) { pos=0;SystemClock::Instance().Add(this); }
    }
    int Step(bool &,SystemClockOffset *next) override {
        value|=unsigned(high)<<pos;pos++;
        *next=delay;
        if(pos==1) *next=delay*3/2;
        else if(pos>=10) {
            if(bytes.size()==LIMIT) throw std::runtime_error("serial receive capacity exceeded");
            bytes.push_back((value>>1)&255);pos=-1;value=0;*next=-1;
        }
        return 0;
    }
};
class Transmit : public Pin, public SimulationMember {
    SystemClockOffset delay;unsigned pos=0,value=0;
 public:
    std::deque<unsigned char> bytes;
    explicit Transmit(unsigned baud):delay(1000000000/baud) { Pin::operator=('H'); }
    int Step(bool &,SystemClockOffset *next) override {
        *next=delay;
        if(!pos) {
            if(bytes.empty()) { *next=delay*100;return 0; }
            value=(unsigned(bytes.front())<<1)|0x200;bytes.pop_front();
        }
        Pin::operator=(value&(1<<pos)?'H':'L');
        pos=(pos+1)%10;return 0;
    }
};
int main(int argc,char **argv) {
 try {
    if(argc!=5&&argc!=7) throw std::runtime_error("expected machine speed baud ELF");
    const auto speed=std::stoul(argv[2]),baud=std::stoul(argv[3]);
    if(speed<1||speed>1000000000||baud<1||baud>100000000) throw std::runtime_error("invalid frequency");
    sysConHandler.SetUseExit(false);sysConHandler.SetMessageStream(&std::cerr);
    auto *dump=DumpManager::Instance();dump->SetSingleDeviceApp();
    AvrDevice *device=AvrFactory::instance().makeDevice(argv[1]);device->Load(argv[4]);
    device->SetClockFreq(1000000000/speed);
    if(argc==7 && std::string(argv[6])=="?") { dump->save(std::cout);return 0; }
    if(argc==7) {
        std::string signals=argv[6],spec;std::istringstream input(signals);std::string name;
        while(std::getline(input,name,',')) { if(name.empty())throw std::runtime_error("empty trace signal");spec+="+ "+name+"\n"; }
        const auto selected=dump->load(spec);if(selected.empty())throw std::runtime_error("no trace signals selected");
        auto *stream=new std::ofstream(argv[5]);
        if(!*stream){delete stream;throw std::runtime_error("cannot open VCD output");}
        stream->exceptions(std::ios::badbit|std::ios::failbit);
        dump->addDumper(new DumpVCD(stream,"ns",false,false),selected);dump->start();
    }
    auto &clock=SystemClock::Instance();Receive rx(baud);Transmit tx(baud);Net rxnet,txnet;
    rxnet.Add(&rx);rxnet.Add(device->GetPin("D1"));txnet.Add(device->GetPin("D0"));txnet.Add(&tx);
    clock.Add(device);clock.Add(&tx);
    unsigned char header[8];
    while(transfer(0,header,8,false)) {
        const auto count=get32(header),duration=get32(header+4);
        if(count>LIMIT||tx.bytes.size()+count>LIMIT||duration<1||duration>100000000) throw std::runtime_error("invalid simulation request");
        std::vector<unsigned char> input(count);
        if(count&&!transfer(0,input.data(),count,false)) throw std::runtime_error("truncated input");
        tx.bytes.insert(tx.bytes.end(),input.begin(),input.end());
        if(clock.GetCurrentTime()>std::numeric_limits<SystemClockOffset>::max()-duration) throw std::runtime_error("simulation clock overflow");
        const auto until=clock.GetCurrentTime()+duration;
        while(clock.GetCurrentTime()<until) { bool step=false;if(clock.Step(step))throw std::runtime_error("simulation breakpoint"); }
        unsigned char reply[12];const uint64_t now=clock.GetCurrentTime();const uint32_t length=rx.bytes.size();
        for(unsigned i=0;i<8;i++)reply[i]=(now>>(i*8))&255;
        for(unsigned i=0;i<4;i++)reply[8+i]=(length>>(i*8))&255;
        transfer(1,reply,12,true);if(length)transfer(1,rx.bytes.data(),length,true);rx.bytes.clear();
    }
    dump->stopApplication();clock.ResetClock();return 0;
 }catch(const std::exception &e) { std::cerr<<e.what()<<std::endl;return 1; }
}
