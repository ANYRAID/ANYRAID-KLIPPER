// Exercise the real AVR instruction engine and externally observed pin edges.
#include <vector>
#include <map>
#include <iostream>
#include <stdexcept>
#include "avrdevice.h"
#include "avrfactory.h"
#include "avrerror.h"
#include "systemclock.h"
#include "pin.h"
#include "net.h"
class Observer : public Pin {
 public:
    std::vector<SystemClockOffset> edges;
    bool high = false;
    void SetInState(const Pin &p) override {
        Pin::SetInState(p);
        const bool next = p.outState == HIGH;
        if(next != high) edges.push_back(SystemClock::Instance().GetCurrentTime());
        high = next;
    }
};
int main(int argc, char **argv) {
 try {
    if(argc != 2) throw std::runtime_error("expected pulse ELF");
    sysConHandler.SetUseExit(false);
    sysConHandler.SetMessageStream(&std::cerr);
    auto &clock = SystemClock::Instance();
    AvrDevice *device = AvrFactory::instance().makeDevice("atmega644");
    device->Load(argv[1]);
    // Preserve the Python frontend's integer nanosecond clock quantum.
    device->SetClockFreq(1000000000 / 16000000);
    Observer observer; Net net; net.Add(&observer); net.Add(device->GetPin("A0"));
    clock.Add(device); clock.RunTimeRange(1000000);
    if(observer.edges.size() < 5000) throw std::runtime_error("missing pulse edges");
    for(size_t i=1;i<observer.edges.size();i++) {
        const auto expected = i%2 ? 124 : 248;
        if(observer.edges[i]-observer.edges[i-1] != expected)
            throw std::runtime_error("incorrect instruction-to-pin timing");
    }
    std::cout << "{\"edges\":" << observer.edges.size()
              << ",\"clockNs\":" << clock.GetCurrentTime()
              << ",\"highNs\":124,\"lowNs\":248}" << std::endl;
    clock.ResetClock();
    // The simulator owns process-global registries; isolate each run in a process.
    return 0;
 } catch(const std::exception &e) { std::cerr << e.what() << std::endl; return 1; }
}
