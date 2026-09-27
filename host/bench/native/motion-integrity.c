/* Bounded diagnostic control for the legacy fourth-order motion fixture.
 * Same arithmetic ordering, no fast-math/FMA. Not a production motion planner.
 * Original simulation: Kevin O'Connor / Dmitry Butyugin, GPL-3.0-or-later. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include <float.h>
#include <fenv.h>
_Static_assert(sizeof(double)==8 && DBL_MANT_DIG==53 && FLT_RADIX==2,
               "binary64 required");
static uint64_t bits(double v){uint64_t out;memcpy(&out,&v,8);return out;}
static double acceleration_position(double t,double v,double a,double duration){
    double inv=1/duration,a1=a*inv,a2=a1*inv;
    return ((-.5*a2*t+a1)*t*t+v)*t;
}
static int nominal_positions(double *output,size_t n){
    static const double moves[][3]={
        {0,0,.1},{6.869,89.443,0},{89.443,89.443,.12},
        {89.443,17.361,0},{19.410,120,0},{120,120,.13},
        {120,5,0},{0,0,.01},{-5,-100,0},{-100,-100,.1},
        {-100,-.5,0},{0,0,.2}};
    double start_d=0,start_t=0,time=0;size_t used=0;
    for(size_t i=0;i<sizeof(moves)/sizeof(moves[0]);i++){
        double v=moves[i][0],end_v=moves[i][1];
        double effective=fmin(sqrt((3000*.6*35)*fabs(end_v-v)/6),3000);
        double duration=moves[i][2]?moves[i][2]:fabs(end_v-v)/effective;
        double a=(end_v-v)/duration,end=start_t+duration;
        while(time<=end){
            if(used>=n)return 0;
            output[used++]=start_d+
                acceleration_position(time-start_t,v,a,duration);
            time+=.0001;
        }
        start_d+=acceleration_position(duration,v,a,duration);start_t=end;
    }
    return used==n;
}
static void spring(const double *input,double *output,size_t n){
    const double dt=.0001,pi=3.14159265358979323846;
    const double omega=35*2*pi,omega2=omega*omega,damping=4*pi*.05*35;
    double position=0,velocity=0;
    for(size_t i=0;i<n;i++){
        position+=velocity*dt;
        double acceleration=(input[i]-position)*omega2;
        velocity+=acceleration*dt;
        velocity-=velocity*damping*dt;
        output[i]=position;
    }
}
static void weighted4(const double *input,double *output,size_t n){
    const double width=83,weight=15/(16*(width*width*width*width*width));
    memset(output,0,n*sizeof(double));
    for(size_t i=500;i<n-500;i++){
        double high=0,low=0;
        for(int delta=-83;delta<83;delta++){
            double q=width*width-delta*delta;
            double value=input[(ptrdiff_t)i+delta]*(q*q),next=high+value;
            low+=fabs(high)>=fabs(value)?(high-next)+value:(value-next)+high;
            high=next;
        }
        output[i]=(high+low)*weight;
    }
}
int main(int argc,char **argv){
    if(argc!=3 && argc!=4){
        fputs("usage: motion-integrity fixture.f64 rounds "
              "[filter-output.f64]\n",stderr);
        return 64;
    }
    char *end;long rounds=strtol(argv[2],&end,10);
    if(*end||rounds<1||rounds>10000)return 64;
    uint16_t endian=1;
    if(*(unsigned char*)&endian!=1||fegetround()!=FE_TONEAREST)return 65;
    FILE *f=fopen(argv[1],"rb");if(!f)return 66;
    uint32_t header[3];
    if(fread(header,sizeof(header),1,f)!=1||header[0]!=0x4d4f5431||
       header[1]<1001||header[1]>100000||header[2]!=header[1]-1000){
        fclose(f);return 65;
    }
    size_t n=header[1],keep=header[2],elements=n+10*keep;
    double *fixture=malloc(elements*sizeof(double));
    double *workspace=calloc(12*n,sizeof(double));
    if(!fixture||!workspace){fclose(f);free(fixture);free(workspace);return 71;}
    if(fread(fixture,sizeof(double),elements,f)!=elements||fgetc(f)!=EOF){
        fclose(f);free(fixture);free(workspace);return 65;
    }
    fclose(f);
    for(size_t i=0;i<elements;i++)if(!isfinite(fixture[i])){
        free(fixture);free(workspace);return 65;
    }
    double *updated=workspace,*head=workspace+n,*newhead=workspace+2*n;
    double *vel=workspace+3*n,*acc=workspace+7*n;
    double *nominal=workspace+11*n,*positions[4]={updated,nominal,head,newhead};
    puts("motion-c:loaded");fflush(stdout);
    for(long run=0;run<rounds;run++){
        if(!nominal_positions(nominal,n)){
            puts("motion-c:position-count-mismatch");
            free(fixture);free(workspace);return 2;
        }
        for(size_t i=0;i<n;i++)if(!isfinite(nominal[i])||
                                fabs(nominal[i]-fixture[i])>1e-12){
            printf("{\"run\":%ld,\"curve\":10,\"index\":%zu,"
                   "\"actual\":%.17g,\"expected\":%.17g,"
                   "\"xor\":\"0x%llx\"}\n",run,i,nominal[i],fixture[i],
                   (unsigned long long)(bits(nominal[i])^bits(fixture[i])));
            free(fixture);free(workspace);return 2;
        }
        weighted4(nominal,updated,n);spring(nominal,head,n);
        spring(updated,newhead,n);
        for(size_t curve=0;curve<4;curve++){
            vel[curve*n]=0;acc[curve*n]=0;
            for(size_t i=1;i<n;i++)
                vel[curve*n+i]=(positions[curve][i]-positions[curve][i-1])*
                    10000;
            for(size_t i=1;i<n;i++)
                acc[curve*n+i]=(vel[curve*n+i]-vel[curve*n+i-1])*10000;
        }
        for(size_t curve=0;curve<10;curve++)for(size_t i=0;i<keep;i++){
            double value=curve<4?vel[curve*n+i]:curve<8?acc[(curve-4)*n+i]:
                (curve==8?newhead[i]:head[i])-nominal[i];
            double expected=fixture[n+curve*keep+i];
            double tolerance=curve<4?1e-8:curve<8?1e-4:1e-10;
            if(!isfinite(value)||fabs(value-expected)>tolerance){
                printf("{\"run\":%ld,\"curve\":%zu,\"index\":%zu,"
                       "\"actual\":%.17g,\"expected\":%.17g,"
                       "\"error\":%.17g,\"xor\":\"0x%llx\"}\n",
                       run,curve,i,value,expected,value-expected,
                       (unsigned long long)(bits(value)^bits(expected)));
                free(fixture);free(workspace);return 2;
            }
        }
    }
    if(argc==4){
        FILE *output=fopen(argv[3],"wb");
        if(!output){free(fixture);free(workspace);return 73;}
        int written=fwrite(nominal,sizeof(double),n,output)==n &&
            fwrite(updated,sizeof(double),n,output)==n;
        int closed=fclose(output);
        if(!written || closed){free(fixture);free(workspace);return 74;}
    }
    printf("motion-c:verified:%ld\n",rounds);
    free(fixture);free(workspace);return 0;
}
